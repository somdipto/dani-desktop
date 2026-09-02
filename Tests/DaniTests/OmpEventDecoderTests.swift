import XCTest
@testable import Dani

// OMP EVENT DECODER UNIT TESTS
// ---------------------------
// Pure unit tests for `OmpEventDecoder.decode(json:)`. No OMP process, no
// network, no hardware — these run in CI. They pin the wire-format contract:
//   - ready frame, prompt ack (success/failure, agentInvoked true/false/nil),
//     prompt_result, agent_start/end (terminal + non-terminal),
//     message_update text_delta (+ ignored variants),
//     tool_execution_start/end, extension_ui_request confirm,
//     parseError, ignored.
//
// The runtime smoke test (OmpRpcRuntimeSmokeTests) exercises the live path
// against a real OMP binary; it's skipped when the binary isn't installed.

final class OmpEventDecoderTests: XCTestCase {

    // MARK: - ready

    func testReadyFrame() {
        let frame = OmpEventDecoder.decode(json: [
            "type": "ready",
            "protocolVersion": 1,
            "supportedProtocolVersions": [1, 2],
            "maxFrameBytes": 1_048_576,
            "maxReassembledFrameBytes": 67_108_864,
        ])
        guard case let .ready(protocolVersion, maxFrameBytes) = frame else {
            return XCTFail("expected .ready, got \(frame)")
        }
        XCTAssertEqual(protocolVersion, 1)
        XCTAssertEqual(maxFrameBytes, 1_048_576)
    }

    func testReadyFrameDefaultsWhenFieldsAbsent() {
        let frame = OmpEventDecoder.decode(json: ["type": "ready"])
        guard case let .ready(protocolVersion, maxFrameBytes) = frame else {
            return XCTFail("expected .ready, got \(frame)")
        }
        XCTAssertEqual(protocolVersion, 1)
        XCTAssertEqual(maxFrameBytes, 1_048_576)
    }

    // MARK: - response (prompt)

    func testPromptAckSuccessAgentInvokedTrue() {
        let frame = OmpEventDecoder.decode(json: [
            "id": "req_1",
            "type": "response",
            "command": "prompt",
            "success": true,
            "data": ["agentInvoked": true],
        ])
        guard case let .responseAck(id, command, success, agentInvoked, error) = frame else {
            return XCTFail("expected .responseAck, got \(frame)")
        }
        XCTAssertEqual(id, "req_1")
        XCTAssertEqual(command, "prompt")
        XCTAssertTrue(success)
        XCTAssertEqual(agentInvoked, true)
        XCTAssertNil(error)
    }

    func testPromptAckSuccessAgentInvokedFalse() {
        // Local-only prompt (slash command) — completion signal.
        let frame = OmpEventDecoder.decode(json: [
            "id": "req_1",
            "type": "response",
            "command": "prompt",
            "success": true,
            "data": ["agentInvoked": false],
        ])
        guard case let .responseAck(_, _, _, agentInvoked, _) = frame else {
            return XCTFail("expected .responseAck, got \(frame)")
        }
        XCTAssertEqual(agentInvoked, false)
    }

    func testPromptAckSuccessNoData() {
        // Older runtime — data absent, agentInvoked nil. Host relies on
        // agent_end / prompt_result.
        let frame = OmpEventDecoder.decode(json: [
            "id": "req_1",
            "type": "response",
            "command": "prompt",
            "success": true,
        ])
        guard case let .responseAck(_, _, _, agentInvoked, _) = frame else {
            return XCTFail("expected .responseAck, got \(frame)")
        }
        XCTAssertNil(agentInvoked)
    }

    func testPromptAckFailure() {
        let frame = OmpEventDecoder.decode(json: [
            "id": "req_1",
            "type": "response",
            "command": "prompt",
            "success": false,
            "error": "rate limited",
        ])
        guard case let .responseAck(_, _, success, _, error) = frame else {
            return XCTFail("expected .responseAck, got \(frame)")
        }
        XCTAssertFalse(success)
        XCTAssertEqual(error, "rate limited")
    }

    // MARK: - prompt_result

    func testPromptResultLocalOnly() {
        let frame = OmpEventDecoder.decode(json: [
            "type": "prompt_result",
            "id": "req_1",
            "agentInvoked": false,
        ])
        guard case let .promptResult(id, agentInvoked) = frame else {
            return XCTFail("expected .promptResult, got \(frame)")
        }
        XCTAssertEqual(id, "req_1")
        XCTAssertFalse(agentInvoked)
    }

    // MARK: - agent events

    func testAgentStart() {
        let frame = OmpEventDecoder.decode(json: ["type": "agent_start"])
        guard case let .agentEvent(event) = frame, case .started = event else {
            return XCTFail("expected .agentEvent(.started), got \(frame)")
        }
    }

    func testAgentEndTerminal() {
        let frame = OmpEventDecoder.decode(json: [
            "type": "agent_end",
            "messages": [["role": "assistant", "content": [["type": "text", "text": "DANI_OK"]]]],
            "isTerminal": true,
        ])
        guard case let .agentEvent(event) = frame, case let .completed(text) = event else {
            return XCTFail("expected .agentEvent(.completed), got \(frame)")
        }
        XCTAssertEqual(text, "DANI_OK")
    }

    func testAgentEndAbsentIsTerminalPerBackwardCompat() {
        // isTerminal absent — older runtimes — treat as terminal.
        let frame = OmpEventDecoder.decode(json: ["type": "agent_end", "messages": []])
        guard case let .agentEvent(event) = frame, case .completed = event else {
            return XCTFail("expected .agentEvent(.completed), got \(frame)")
        }
    }

    func testAgentEndNonTerminalIsIgnored() {
        // isTerminal: false means maintenance/async work scheduled — NOT a
        // run completion. The decoder drops it; the runtime waits for the
        // real terminal agent_end.
        let frame = OmpEventDecoder.decode(json: [
            "type": "agent_end",
            "isTerminal": false,
        ])
        guard case let .ignored(type) = frame else {
            return XCTFail("expected .ignored for non-terminal agent_end, got \(frame)")
        }
        XCTAssertEqual(type, "agent_end_non_terminal")
    }

    func testAgentEndExtractsFinalAssistantText() {
        let frame = OmpEventDecoder.decode(json: [
            "type": "agent_end",
            "isTerminal": true,
            "messages": [
                ["role": "user", "content": [["type": "text", "text": "hi"]]],
                ["role": "assistant", "content": [["type": "text", "text": "Hello "], ["type": "text", "text": "world"]]],
            ],
        ])
        guard case let .agentEvent(event) = frame, case let .completed(text) = event else {
            return XCTFail("expected .agentEvent(.completed), got \(frame)")
        }
        XCTAssertEqual(text, "Hello world")
    }

    func testAgentEndNoAssistantMessage() {
        // Tool-only turn — no assistant text. .completed(nil).
        let frame = OmpEventDecoder.decode(json: [
            "type": "agent_end",
            "isTerminal": true,
            "messages": [["role": "user", "content": [["type": "text", "text": "x"]]]],
        ])
        guard case let .agentEvent(event) = frame, case let .completed(text) = event else {
            return XCTFail("expected .agentEvent(.completed), got \(frame)")
        }
        XCTAssertNil(text)
    }

    // MARK: - message_update

    func testMessageUpdateTextDelta() {
        let frame = OmpEventDecoder.decode(json: [
            "type": "message_update",
            "assistantMessageEvent": ["type": "text_delta", "delta": "Hello"],
            "message": ["role": "assistant", "content": []],
        ])
        guard case let .agentEvent(event) = frame, case let .textDelta(delta) = event else {
            return XCTFail("expected .agentEvent(.textDelta), got \(frame)")
        }
        XCTAssertEqual(delta, "Hello")
    }

    func testMessageUpdateEmptyTextDeltaIsIgnored() {
        let frame = OmpEventDecoder.decode(json: [
            "type": "message_update",
            "assistantMessageEvent": ["type": "text_delta", "delta": ""],
        ])
        guard case .ignored = frame else {
            return XCTFail("expected .ignored for empty text_delta, got \(frame)")
        }
    }

    func testMessageUpdateThinkingDeltaIsIgnored() {
        // The spec: no chain-of-thought in the UI. thinking_delta is dropped.
        let frame = OmpEventDecoder.decode(json: [
            "type": "message_update",
            "assistantMessageEvent": ["type": "thinking_delta", "delta": "internal reasoning"],
        ])
        guard case .ignored = frame else {
            return XCTFail("expected .ignored for thinking_delta, got \(frame)")
        }
    }

    func testMessageUpdateMissingAssistantEventIsIgnored() {
        let frame = OmpEventDecoder.decode(json: ["type": "message_update"])
        guard case .ignored = frame else {
            return XCTFail("expected .ignored, got \(frame)")
        }
    }

    // MARK: - tool execution

    func testToolExecutionStartWithName() {
        let frame = OmpEventDecoder.decode(json: [
            "type": "tool_execution_start",
            "toolName": "computer",
        ])
        guard case let .agentEvent(event) = frame, case let .toolStarted(name) = event else {
            return XCTFail("expected .agentEvent(.toolStarted), got \(frame)")
        }
        XCTAssertEqual(name, "computer")
    }

    func testToolExecutionStartFallsBackToNameField() {
        let frame = OmpEventDecoder.decode(json: [
            "type": "tool_execution_start",
            "name": "bash",
        ])
        guard case let .agentEvent(event) = frame, case let .toolStarted(name) = event else {
            return XCTFail("expected .agentEvent(.toolStarted), got \(frame)")
        }
        XCTAssertEqual(name, "bash")
    }

    func testToolExecutionStartNoNameFallsBackToTool() {
        let frame = OmpEventDecoder.decode(json: ["type": "tool_execution_start"])
        guard case let .agentEvent(event) = frame, case let .toolStarted(name) = event else {
            return XCTFail("expected .agentEvent(.toolStarted), got \(frame)")
        }
        XCTAssertEqual(name, "tool")
    }

    func testToolExecutionEnd() {
        let frame = OmpEventDecoder.decode(json: ["type": "tool_execution_end", "toolName": "computer"])
        guard case let .agentEvent(event) = frame, case let .toolFinished(name) = event else {
            return XCTFail("expected .agentEvent(.toolFinished), got \(frame)")
        }
        XCTAssertEqual(name, "computer")
    }

    // MARK: - extension_ui_request (approval)

    func testNeedsApprovalConfirm() {
        let frame = OmpEventDecoder.decode(json: [
            "type": "extension_ui_request",
            "id": "ui_7",
            "method": "confirm",
            "title": "Confirm",
            "message": "Send this email?",
        ])
        guard case let .agentEvent(event) = frame,
              case let .needsApproval(requestId, prompt) = event else {
            return XCTFail("expected .agentEvent(.needsApproval), got \(frame)")
        }
        XCTAssertEqual(requestId, "ui_7")
        XCTAssertEqual(prompt, "Confirm\nSend this email?")
    }

    func testExtensionUIRequestNonConfirmIsIgnored() {
        let frame = OmpEventDecoder.decode(json: [
            "type": "extension_ui_request",
            "id": "ui_8",
            "method": "input",
            "title": "Branch name",
        ])
        guard case .ignored = frame else {
            return XCTFail("expected .ignored for method=input, got \(frame)")
        }
    }

    // MARK: - tolerance

    func testMissingTypeIsParseError() {
        let frame = OmpEventDecoder.decode(json: ["foo": "bar"])
        guard case .parseError = frame else {
            return XCTFail("expected .parseError, got \(frame)")
        }
    }

    func testUnknownTypeIsIgnored() {
        let frame = OmpEventDecoder.decode(json: ["type": "some_new_event_kind"])
        guard case let .ignored(type) = frame else {
            return XCTFail("expected .ignored, got \(frame)")
        }
        XCTAssertEqual(type, "unknown_some_new_event_kind")
    }

    func testKnownIgnoredFrameTypes() {
        for type in [
            "rpc_chunk", "extension_error", "available_commands_update",
            "host_tool_call", "host_tool_cancel", "host_uri_request", "host_uri_cancel",
            "subagent_lifecycle", "subagent_progress", "subagent_event",
            "command_output", "session_info_update", "config_update",
            "model_changed", "thinking_level_changed", "ttsr_triggered",
            "todo_reminder", "todo_auto_clear", "irc_message", "notice", "goal_updated",
            "auto_compaction_start", "auto_compaction_end",
            "auto_retry_start", "auto_retry_end",
            "retry_fallback_applied", "retry_fallback_succeeded",
            "turn_start", "turn_end", "message_start", "message_end",
            "tool_execution_update",
        ] {
            let frame = OmpEventDecoder.decode(json: ["type": type])
            guard case .ignored = frame else {
                return XCTFail("expected .ignored for \(type), got \(frame)")
            }
        }
    }
}
