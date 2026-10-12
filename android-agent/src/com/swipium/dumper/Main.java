package com.swipium.dumper;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Point;
import android.graphics.Rect;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;

/**
 * Swipium persistent UI dumper. Run with:
 *   CLASSPATH=/data/local/tmp/swipium-dumper.jar app_process / com.swipium.dumper.Main [socketName] [idleExitMs]
 *
 * Keeps ONE UiAutomation connection open and serves the active window's accessibility tree in
 * the same XML format `uiautomator dump` writes. Protocol on localabstract:<socketName>
 * (forward it with `adb forward tcp:N localabstract:<socketName>`): one request per
 * connection, a single line, then the server writes the answer and closes.
 *   PING                         -> "PONG\n"
 *   DUMP [idleMs] [timeoutMs]    -> XML document, or "ERR <message>\n"
 *   QUIT                         -> "BYE\n", then the process exits (connection released)
 * The process also exits after idleExitMs without requests (default 10 min) so a stray agent
 * never keeps the device's single UiAutomation slot.
 */
public final class Main {
  private static final int ROOT_UID = 0;
  private static final int SHELL_UID = 2000; // android.os.Process.SHELL_UID (adbd)
  private static final int READ_TIMEOUT_MS = 5000;
  private static volatile long lastRequest = System.currentTimeMillis();
  /** uptime of the last accessibility event (any window), fed by the UiAutomation listener. */
  private static volatile long lastEvent = 0;

  public static void main(String[] args) throws Exception {
    String socketName = args.length > 0 ? args[0] : "swipium-dumper";
    final long idleExitMs = args.length > 1 ? Long.parseLong(args[1]) : 600_000L;

    // AccessibilityInteractionClient builds a Handler on the main looper: it must exist and loop.
    Looper.prepareMainLooper();
    HandlerThread ht = new HandlerThread("SwipiumDumper");
    ht.start();
    UiAutomation ua = connect(ht.getLooper());
    AccessibilityServiceInfo info = ua.getServiceInfo();
    if (info != null) {
      // Same tree as `uiautomator dump` (non-compressed): include not-important views + view ids.
      info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
          | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
      ua.setServiceInfo(info);
    }
    ua.setOnAccessibilityEventListener(e -> lastEvent = SystemClock.uptimeMillis());

    Thread watchdog = new Thread(() -> {
      while (true) {
        try {
          Thread.sleep(5000);
        } catch (InterruptedException e) {
          return;
        }
        if (System.currentTimeMillis() - lastRequest > idleExitMs) {
          System.err.println("swipium-dumper: idle, exiting");
          shutdown(ua);
        }
      }
    });
    watchdog.setDaemon(true);
    watchdog.start();

    final LocalServerSocket server = new LocalServerSocket(socketName);
    Thread serve = new Thread(() -> serve(ua, server), "SwipiumDumperServer");
    serve.start();
    System.out.println("READY " + socketName);
    System.out.flush();
    Looper.loop();
  }

  private static void serve(UiAutomation ua, LocalServerSocket server) {
    while (true) {
      LocalSocket s;
      try {
        s = server.accept();
      } catch (Exception e) {
        System.err.println("swipium-dumper: accept failed: " + e);
        shutdown(ua);
        return;
      }
      try {
        // The socket is an abstract name any app on the device can connect to: serve only adb
        // (shell, through `adb forward`) and root, so an installed app cannot read the screen or
        // hold the single-threaded server. A silent client is dropped instead of blocking it.
        int uid = s.getPeerCredentials().getUid();
        if (uid != SHELL_UID && uid != ROOT_UID) {
          System.err.println("swipium-dumper: refused a connection from uid " + uid);
          continue;
        }
        s.setSoTimeout(READ_TIMEOUT_MS);
        lastRequest = System.currentTimeMillis();
        handle(ua, s);
      } catch (Throwable t) {
        System.err.println("swipium-dumper: request failed: " + t);
      } finally {
        try {
          s.close();
        } catch (Exception ignored) {
        }
      }
    }
  }

  private static void shutdown(UiAutomation ua) {
    try {
      Method m = UiAutomation.class.getDeclaredMethod("disconnect");
      m.setAccessible(true);
      m.invoke(ua);
    } catch (Throwable ignored) {
    }
    System.exit(0);
  }

  private static void handle(UiAutomation ua, LocalSocket s) throws Exception {
    BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
    OutputStream out = s.getOutputStream();
    String line = in.readLine();
    if (line == null) return;
    String[] parts = line.trim().split("\\s+");
    String cmd = parts[0].toUpperCase();
    if (cmd.equals("PING")) {
      out.write("PONG\n".getBytes(StandardCharsets.UTF_8));
    } else if (cmd.equals("QUIT")) {
      out.write("BYE\n".getBytes(StandardCharsets.UTF_8));
      out.flush();
      shutdown(ua);
    } else if (cmd.equals("DUMP")) {
      long idleMs = parts.length > 1 ? Long.parseLong(parts[1]) : 250;
      long timeoutMs = parts.length > 2 ? Long.parseLong(parts[2]) : 2000;
      String xml;
      try {
        xml = dump(ua, idleMs, timeoutMs);
      } catch (Throwable t) {
        xml = "ERR " + String.valueOf(t).replace('\n', ' ') + "\n";
      }
      out.write(xml.getBytes(StandardCharsets.UTF_8));
    } else {
      out.write(("ERR unknown command " + cmd + "\n").getBytes(StandardCharsets.UTF_8));
    }
    out.flush();
  }

  /** new UiAutomation(looper, new UiAutomationConnection()).connect(FLAG_DONT_SUPPRESS...) via reflection
   * (both are @hide; this is what uiautomator's UiAutomationShellWrapper does). */
  private static UiAutomation connect(Looper looper) throws Exception {
    Class<?> connCls = Class.forName("android.app.UiAutomationConnection");
    Constructor<?> connCtor = connCls.getDeclaredConstructor();
    connCtor.setAccessible(true);
    Object conn = connCtor.newInstance();
    Class<?> iconn = Class.forName("android.app.IUiAutomationConnection");
    Constructor<UiAutomation> uaCtor = UiAutomation.class.getDeclaredConstructor(Looper.class, iconn);
    uaCtor.setAccessible(true);
    UiAutomation ua = uaCtor.newInstance(looper, conn);
    Method connect = UiAutomation.class.getDeclaredMethod("connect", int.class);
    connect.setAccessible(true);
    // Don't kill the user's TalkBack/other a11y services for the agent's lifetime.
    connect.invoke(ua, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
    return ua;
  }

  private static String dump(UiAutomation ua, long idleMs, long timeoutMs) throws Exception {
    // Quiet for idleMs counted from the REQUEST, not just since the last event: a dump asked for
    // right after `input tap` must not return the old screen before the tap's events arrive
    // (UiAutomation.waitForIdle returns at once when the device was already quiet).
    // On timeout (looping animation) dump what is there instead of failing.
    long start = SystemClock.uptimeMillis();
    if (idleMs > 0) {
      while (true) {
        long now = SystemClock.uptimeMillis();
        long quietSince = Math.max(lastEvent, start);
        if (now - quietSince >= idleMs || now - start >= timeoutMs) break;
        Thread.sleep(Math.min(20, idleMs));
      }
    }
    AccessibilityNodeInfo root = null;
    for (int i = 0; i < 10 && root == null; i++) {
      root = ua.getRootInActiveWindow();
      if (root == null) Thread.sleep(50);
    }
    if (root == null) throw new IllegalStateException("null root node");
    int rotation = 0;
    Point size = new Point();
    try {
      Class<?> dmg = Class.forName("android.hardware.display.DisplayManagerGlobal");
      Object inst = dmg.getMethod("getInstance").invoke(null);
      Object display = dmg.getMethod("getRealDisplay", int.class).invoke(inst, 0);
      rotation = (Integer) display.getClass().getMethod("getRotation").invoke(display);
      display.getClass().getMethod("getRealSize", Point.class).invoke(display, size);
    } catch (Throwable t) {
      Rect r = new Rect();
      root.getBoundsInScreen(r);
      size.set(r.right, r.bottom);
    }
    StringBuilder sb = new StringBuilder(64 * 1024);
    sb.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>");
    sb.append("<hierarchy rotation=\"").append(rotation).append("\">");
    node(sb, root, 0, size.x, size.y);
    sb.append("</hierarchy>");
    return sb.toString();
  }

  /** Mirrors AOSP AccessibilityNodeInfoDumper.dumpNodeRec (attribute set and order). */
  private static void node(StringBuilder sb, AccessibilityNodeInfo n, int index, int w, int h) {
    sb.append("<node");
    attr(sb, "index", Integer.toString(index));
    attr(sb, "text", n.getText());
    attr(sb, "resource-id", n.getViewIdResourceName());
    attr(sb, "class", n.getClassName());
    attr(sb, "package", n.getPackageName());
    attr(sb, "content-desc", n.getContentDescription());
    attr(sb, "checkable", b(n.isCheckable()));
    attr(sb, "checked", b(n.isChecked()));
    attr(sb, "clickable", b(n.isClickable()));
    attr(sb, "enabled", b(n.isEnabled()));
    attr(sb, "focusable", b(n.isFocusable()));
    attr(sb, "focused", b(n.isFocused()));
    attr(sb, "scrollable", b(n.isScrollable()));
    attr(sb, "long-clickable", b(n.isLongClickable()));
    attr(sb, "password", b(n.isPassword()));
    attr(sb, "selected", b(n.isSelected()));
    Rect r = new Rect();
    n.getBoundsInScreen(r);
    // Visible bounds clipped to the display, like AccessibilityNodeInfoHelper.getVisibleBoundsInScreen.
    if (w > 0 && h > 0 && !r.intersect(0, 0, w, h)) r.setEmpty();
    attr(sb, "bounds", "[" + r.left + "," + r.top + "][" + r.right + "," + r.bottom + "]");
    attr(sb, "drawing-order", Integer.toString(n.getDrawingOrder()));
    attr(sb, "hint", n.getHintText());
    int count = n.getChildCount();
    if (count == 0) {
      sb.append(" />");
      return;
    }
    sb.append(">");
    for (int i = 0; i < count; i++) {
      AccessibilityNodeInfo c = n.getChild(i);
      if (c == null) continue;
      if (c.isVisibleToUser()) node(sb, c, i, w, h);
    }
    sb.append("</node>");
  }

  private static String b(boolean v) {
    return v ? "true" : "false";
  }

  private static void attr(StringBuilder sb, String name, CharSequence value) {
    sb.append(' ').append(name).append("=\"");
    if (value != null) {
      for (int i = 0; i < value.length(); i++) {
        char c = value.charAt(i);
        switch (c) {
          case '&': sb.append("&amp;"); break;
          case '<': sb.append("&lt;"); break;
          case '>': sb.append("&gt;"); break;
          case '"': sb.append("&quot;"); break;
          case '\'': sb.append("&apos;"); break;
          case '\n': sb.append("&#10;"); break;
          case '\r': sb.append("&#13;"); break;
          case '\t': sb.append("&#9;"); break;
          default:
            // Drop characters that are invalid in XML 1.0 (uiautomator strips them too).
            if (c >= 0x20 && c != 0xFFFE && c != 0xFFFF) sb.append(c);
        }
      }
    }
    sb.append('"');
  }
}
