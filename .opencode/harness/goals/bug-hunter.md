# Goal: OpenDex Bug-Hunter Autonomous Loop

## Mission
Keep the OpenDex Electron app building clean. Every 5 minutes, check for typecheck and build errors. Fix them one at a time. Log everything.

## How to run
```bash
cd /Users/dan/Desktop/x/daxxxx/dbbb/opendex
pnpm typecheck 2>&1 | tee /tmp/typecheck-latest.txt
pnpm build 2>&1 | tee /tmp/build-latest.txt
```

## If errors exist
1. Read the FIRST error only
2. Open the file, understand the root cause
3. Make the smallest correct edit
4. Re-run the failing command to verify
5. Append to GAUNTLET-WORKLOG.md:
   ```
   ## Task N (auto @ <timestamp>)
   - Error: <exact message>
   - File: <path:line>
   - Fix: <what changed>
   - Result: <pass/fail>
   ```

## If clean (0 errors)
- Typecheck clean AND build clean → mark DONE
- Write DONE to `.opencode/harness/goals/DONE`

## Rules
- ONE error per tick
- Never edit test files
- Never skip verification
- If stuck after 2 attempts on same error, log it and move on
