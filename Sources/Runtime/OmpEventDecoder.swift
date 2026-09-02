import Foundation

// OMP EVENT DECODER
// -----------------
// Pure function: takes one parsed JSON frame from OMP stdout and returns a
// `OmpDecodedFrame` the runtime acts on. Never throws — malformed JSON is
// the caller's problem (it surfaces as a parse error before reaching here);
// unknown frame types return `.ignored` so the app logs-and-continues
// instead of crashing when OMP adds new events.
//
// This is the ONLY place that knows OMP's event names. Everything upstream
// (OmpRpcRuntime) sees `DaniRunEvent`s.
//
// Source of truth for the wire format:
// https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md
//
// Completion semantics (critical): prompt acknowledgment is NOT agent
// completion. A tool-using run produces agent_start → message_* →
// tool_execution_* → message_* → agent_end. The run finishes when `agent_end`
// arrives with `isTerminal != false`. The field is optional — frames from
// older runtimes where it's absent are terminal-compatible (treat as done).

// MARK: - OmpDecodedFrame

/// What `OmpEventDecoder` made of one OMP stdout frame.
enum OmpDecodedFrame: Equatable {
    /// The startup ready frame. `protocolVersion` defaults to 1 if absent.
    /// MVP stays on v1 (no `negotiate_protocol`); v2 only matters for frames
    /// above 1 MiB, which DANI prompts and text deltas never hit.
    case ready(protocolVersion: Int, maxFrameBytes: Int)

    /// A command response, correlated by `id`. For `prompt`, `agentInvoked`
    /// carries the local-only completion signal: `false` means the prompt
    /// resolved without an agent turn (slash command), `true` means agent
    /// lifecycle events will/did follow, `nil` means "unknown — rely on
    /// `agent_end` / `prompt_result`".
    case responseAck(id: String, command: String, success: Bool, agentInvoked: Bool?, error: String?)

    /// A late local-only completion for a prompt that was accepted
    /// immediately. If `agentInvoked == false`, the matching run is done.
    case promptResult(id: String?, agentInvoked: Bool)

    /// An agent lifecycle event routed to the current run.
    case agentEvent(DaniRunEvent)

    /// Malformed JSON or a frame missing required fields. The runtime logs
    /// and continues — OMP's parse loop does the same (malformed JSON emits a
    /// recoverable `command: "parse"` failure, doesn't terminate).
    case parseError(String)

    /// A known frame type we don't yet handle (host_tool_call, host_uri_request,
    /// available_commands_update, extension_error, subagent_*, model_changed,
    /// etc.). The runtime debug-logs and drops it.
    case ignored(type: String)
}

// MARK: - OmpEventDecoder

enum OmpEventDecoder {
    /// Decode one parsed JSON frame. `json` is the top-level `[String: Any]`
    /// from `JSONSerialization` (the process layer handles parsing + framing).
    static func decode(json: [String: Any]) -> OmpDecodedFrame {
        guard let type = json["type"] as? String else {
            return .parseError("missing \"type\" field")
        }

        switch type {
        case "ready":
            let proto = (json["protocolVersion"] as? Int) ?? 1
            let maxBytes = (json["maxFrameBytes"] as? Int) ?? 1_048_576
            return .ready(protocolVersion: proto, maxFrameBytes: maxBytes)

        case "response":
            // { id?, type: "response", command: <cmd>, success: bool, data?: ..., error?: string }
            let id = json["id"] as? String ?? ""
            let command = (json["command"] as? String) ?? ""
            let success = (json["success"] as? Bool) ?? false
            let error = json["error"] as? String
            let data = json["data"] as? [String: Any]
            // data.agentInvoked only exists for prompt responses.
            let agentInvoked: Bool?
            if let data, let v = data["agentInvoked"] as? Bool {
                agentInvoked = v
            } else {
                agentInvoked = nil
            }
            return .responseAck(id: id, command: command, success: success, agentInvoked: agentInvoked, error: error)

        case "prompt_result":
            // { type: "prompt_result", id?: string, agentInvoked: bool }
            let id = json["id"] as? String
            let agentInvoked = (json["agentInvoked"] as? Bool) ?? true
            return .promptResult(id: id, agentInvoked: agentInvoked)

        case "agent_start":
            return .agentEvent(.started)

        case "agent_end":
            // { type: "agent_end", messages?: [...], isTerminal?: bool }
            // isTerminal absent => terminal (backward-compat per OMP docs).
            if let isTerminal = json["isTerminal"] as? Bool, isTerminal == false {
                // Maintenance/async work scheduled — NOT a run completion. Drop
                // and wait for the real terminal agent_end.
                return .ignored(type: "agent_end_non_terminal")
            }
            let finalText = extractFinalAssistantText(json["messages"])
            return .agentEvent(.completed(finalText))

        case "message_update":
            // { type: "message_update", assistantMessageEvent: { type, delta? }, message: {...} }
            guard let evt = json["assistantMessageEvent"] as? [String: Any] else {
                return .ignored(type: "message_update_no_assistant_event")
            }
            guard let evtType = evt["type"] as? String else {
                return .ignored(type: "message_update_no_type")
            }
            switch evtType {
            case "text_delta":
                let delta = (evt["delta"] as? String) ?? ""
                if delta.isEmpty { return .ignored(type: "text_delta_empty") }
                return .agentEvent(.textDelta(delta))
            default:
                // thinking_delta, toolcall_delta, etc. — not surfaced to the
                // desktop UI (the spec: no chain-of-thought, no JSON, no
                // coordinates, no raw agent logs).
                return .ignored(type: "message_update_\(evtType)")
            }

        case "message_start", "message_end", "turn_start", "turn_end",
             "tool_execution_update", "auto_compaction_start", "auto_compaction_end",
             "auto_retry_start", "auto_retry_end", "retry_fallback_applied",
             "retry_fallback_succeeded", "thinking_level_changed", "ttsr_triggered",
             "todo_reminder", "todo_auto_clear", "irc_message", "notice", "goal_updated":
            // Known but not surfaced to the desktop UI for MVP.
            return .ignored(type: type)

        case "tool_execution_start":
            return .agentEvent(.toolStarted(name: toolName(json) ?? "tool"))

        case "tool_execution_end":
            return .agentEvent(.toolFinished(name: toolName(json) ?? "tool"))

        case "extension_ui_request":
            // { type: "extension_ui_request", id, method, title?, message?, timeout? }
            guard let method = json["method"] as? String else {
                return .ignored(type: "extension_ui_request_no_method")
            }
            switch method {
            case "confirm":
                let id = (json["id"] as? String) ?? ""
                let title = (json["title"] as? String) ?? ""
                let message = (json["message"] as? String) ?? ""
                let prompt = [title, message].filter { !$0.isEmpty }.joined(separator: "\n")
                return .agentEvent(.needsApproval(requestId: id, prompt: prompt))
            default:
                // select / input / editor / notify / etc. — not surfaced for MVP.
                return .ignored(type: "extension_ui_request_\(method)")
            }

        // Frame types the desktop app doesn't act on for MVP. Logged + dropped.
        case "rpc_chunk", "extension_error", "available_commands_update",
             "host_tool_call", "host_tool_cancel", "host_uri_request", "host_uri_cancel",
             "subagent_lifecycle", "subagent_progress", "subagent_event",
             "command_output", "session_info_update", "config_update":
            return .ignored(type: type)

        default:
            // Unknown type — OMP may have added something new. Tolerate it.
            return .ignored(type: "unknown_\(type)")
        }
    }

    // MARK: - Helpers

    /// Pull the final assistant text out of `agent_end.messages`. OMP's
    /// `AgentMessage` shape is `{ role, content: [{ type: "text", text }] }`.
    /// Returns nil if there's no assistant text (the run completed without
    /// producing a final message — e.g. a tool-only turn).
    private static func extractFinalAssistantText(_ messages: Any?) -> String? {
        guard let arr = messages as? [[String: Any]] else { return nil }
        // Find the last assistant message.
        guard let lastAssistant = arr.last(where: { ($0["role"] as? String) == "assistant" }) else {
            return nil
        }
        guard let content = lastAssistant["content"] as? [[String: Any]] else { return nil }
        let texts = content.compactMap { block -> String? in
            guard (block["type"] as? String) == "text" else { return nil }
            return block["text"] as? String
        }
        let joined = texts.joined(separator: "")
        return joined.isEmpty ? nil : joined
    }

    /// Tool name from a tool_execution_* frame. OMP doesn't document the exact
    /// field name in rpc.md; tolerate `toolName`, `name`, or `tool`. Falls back
    /// to "tool" so the UI still shows *something*.
    private static func toolName(_ json: [String: Any]) -> String? {
        if let s = json["toolName"] as? String, !s.isEmpty { return s }
        if let s = json["name"] as? String, !s.isEmpty { return s }
        if let s = json["tool"] as? String, !s.isEmpty { return s }
        return nil
    }
}
