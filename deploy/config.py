# Hub connection defaults (override via env or -H flag)
import os
PI_HOST = os.environ.get("PI_HOST", "pi@<tailscale-ip>")
