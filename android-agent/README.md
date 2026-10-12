# Swipium Android dumper

An opt-in, persistent UI dumper for Android Emulators. With `SWIPIUM_ANDROID_DUMPER=agent` in the
MCP server's `env`, Swipium reads the UI tree through this agent instead of running
`adb exec-out uiautomator dump` for every snapshot. It is off by default.

## What it does

- Swipium pushes `prebuilt/swipium-dumper.jar` (a dex jar of about 6 KB) to
  `/data/local/tmp/swipium-dumper.jar` and starts it with
  `CLASSPATH=/data/local/tmp/swipium-dumper.jar app_process / com.swipium.dumper.Main`. No APK is
  installed.
- The agent keeps one UiAutomation connection open and serves dumps on the abstract socket
  `localabstract:swipium-dumper`, which Swipium reaches through `adb forward`. It serves only
  connections from the shell user (adb) or root (peer uid check), so apps on the device cannot
  read the screen through it. Each dump waits for
  250 ms without accessibility events, counted from the request, and dumps anyway after at most 2 s
  on a screen that never goes idle.
- The XML is the same as `uiautomator dump` produces (same attributes, order and visibility rules).
- Any failure (push, start, socket, an `ERR` reply) stops the agent and falls back to
  `uiautomator dump` for 60 s, and logs a `warn` line ("android dumper failed; using uiautomator
  dump for a while") with the error.
- The agent exits 120 s after its last request or when Swipium exits. Swipium removes the jar and
  the `adb forward` entries it made when it stops the agent, after a failure, and when the server
  shuts down (SIGINT, SIGTERM or the client disconnecting; best effort, at most about 1 s). A
  server killed with SIGKILL can leave them behind; both are harmless and the next run's shutdown
  removes the jar again. A jar pushed by another Swipium process whose agent is reused is left alone.

How much faster depends on the host. On a quiet host (API 36 emulator, Settings, 86
nodes): about 0.28 s per dump on a static screen (`uiautomator dump`: about 2.0 s, so about 7x) and
about 0.6 s right after a navigation (about 2.9 s). On a busy host with other emulators and builds
running, `qa_snapshot` on the same screen took 0.5 to 1.4 s instead of 2.2 to 3.0 s, and taps 1.1 to
1.9 s instead of 2.4 to 2.7 s: about 2x to 3x. A screen that never goes idle (a ticking clock) still
waits up to the 2 s idle limit per dump.

## Limits

- Android allows one UiAutomation client at a time. While the agent runs, Appium UiAutomator2,
  Maestro and `uiautomator dump` started outside Swipium fail with "UiAutomationService already
  registered". Wait two minutes after the last Swipium snapshot, or unset the variable.
- The device write is gated only by the opt-in variable; there is no consent prompt for it yet.
- The abstract socket has no file permissions, so access control is the peer uid check: apps on
  the emulator are refused, but any other process running as the shell user (or root) can request
  dumps while the agent runs. Leave the agent off on emulators where untrusted code runs as shell
  or root.

## Building

`android-agent/build.sh` rebuilds `prebuilt/swipium-dumper.jar`. It needs a JDK (`javac` 11 or
newer, plus `jar`) and the Android SDK (`platforms/android-<N>/android.jar` and build-tools `d8`).
It uses `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then `~/Library/Android/sdk`, and the newest
platform and build-tools found there (override with `SWIPIUM_AGENT_API` and
`SWIPIUM_AGENT_BUILD_TOOLS`). Commit the rebuilt jar: the npm package ships `prebuilt/`, `src/` and
`build.sh`.

`test/androidDumper.test.ts` covers the driver side without a device.
`test/androidDumper.device.test.ts` runs against a real emulator when `SWIPIUM_DEVICE_SERIAL` is
set.
