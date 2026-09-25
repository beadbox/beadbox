#!/usr/bin/env python3
# Stand-in for `bd serve` in serve-manager tests (beadbox-6x2 L2). Checks the
# token conditions itself (file present, 0600, in a 0700 dir), binds
# 127.0.0.1:0, prints bd 1.3.0's exact listening line, then holds the socket.
# FAKE_SERVE_LINE=wrong prints a non-loopback line instead (startup-failure
# tests). Any argv other than bd's serve shape exits 2.
import os, socket, stat, sys, time

args = sys.argv[1:]
if len(args) != 5 or args[:3] != ["serve", "--addr", "127.0.0.1:0"] or args[3] != "--auth-token-file":
    sys.stderr.write("fake bd: unexpected argv %r\n" % (args,))
    sys.exit(2)
token = args[4]
st = os.stat(token)
dst = os.stat(os.path.dirname(token))
if stat.S_IMODE(st.st_mode) != 0o600 or stat.S_IMODE(dst.st_mode) != 0o700:
    sys.stderr.write("fake bd: bad token modes\n")
    sys.exit(3)
s = socket.socket()
s.bind(("127.0.0.1", 0))
s.listen(8)
port = s.getsockname()[1]
host = "0.0.0.0" if os.environ.get("BEADS_DOLT_FAKE_SERVE_LINE") == "wrong" else "127.0.0.1"
print("bd serve: listening on http://%s:%d" % (host, port), flush=True)
while True:
    try:
        c, _ = s.accept()
        c.close()
    except OSError:
        time.sleep(0.05)
