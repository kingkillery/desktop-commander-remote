# -*- coding: utf-8 -*-
"""
Fabric deployment script for Desktop Commander Remote.

HUB — Raspberry Pi / systemd (current):
  fab -H pk@100.71.124.50 deploy        # First-time hub deploy
  fab -H pk@100.71.124.50 update        # Update hub code + restart
  fab -H pk@100.71.124.50 status        # Hub service status
  fab -H pk@100.71.124.50 logs          # Tail hub logs
  fab -H pk@100.71.124.50 restart       # Restart hub
  fab -H pk@100.71.124.50 show-config   # Print API key + connection info

HUB — Cloud / Docker (future: GCP, AWS, Hetzner, etc.):
  fab -H user@cloud-vm deploy-docker    # Build image + start with Tailscale sidecar
  fab -H user@cloud-vm docker-update    # Rebuild image + rolling restart
  fab -H user@cloud-vm docker-logs      # Tail hub + tailscale logs
  fab -H user@cloud-vm docker-status    # Show container status

DEVICE CLIENTS (register each machine with the hub):
  fab -H k@100.76.176.119 deploy-device   # Mac (jims-mac-mini) - launchd
  fab -H pk@100.71.124.50 deploy-device   # Pi itself (optional)
  setup-windows                           # Windows MSI (local, no -H needed)

Prerequisites:
  pip install fabric
  Mac: run once on Mac to authorize key:
    echo '<pub key from ~/.ssh/jims-mac-mini.pub>' >> ~/.ssh/authorized_keys
  Cloud: set TS_AUTHKEY in hub/.env before deploy-docker
"""

from fabric import task, Connection
from invoke import run as local_run
import os
import sys

# Force UTF-8 output on Windows
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# -- Config -------------------------------------------------------------------
SSH_KEY = os.path.expanduser("~/.ssh/pk-jim-2")
REMOTE_DIR = "/opt/dc-remote-hub"
DEVICE_DIR = "/opt/dc-remote-device"     # Linux remote device dir
HUB_WS_URL = "ws://100.71.124.50:3001"
HUB_API_KEY = "bb5dfda7-06a3-4695-b2c1-1bfc053a9b8b"
SERVICE_NAME = "dc-remote-hub"
NODE_VERSION = "20"  # minimum LTS
HUB_PORT = 3000
WS_PORT = 3001


# -- Tasks --------------------------------------------------------------------

@task
def deploy(c):
    """Full first-time deployment: install Node.js, deploy code, create systemd service."""
    install_node(c)
    push_code(c)
    install_deps(c)
    build(c)
    install_service(c)
    c.run(f"sudo systemctl enable {SERVICE_NAME}")
    c.run(f"sudo systemctl start {SERVICE_NAME}")
    print("\n[ok] Hub deployed and started!")
    status(c)


@task
def update(c):
    """Push updated code and restart service."""
    push_code(c)
    install_deps(c)
    build(c)
    restart(c)
    print("[ok] Update complete")


@task
def push_code(c):
    """Upload hub source to Pi via SFTP (Windows-compatible, no rsync needed)."""
    import pathlib

    hub_dir = pathlib.Path(__file__).parent.parent / "hub"
    SKIP_DIRS = {"node_modules", "dist", ".git"}
    SKIP_EXTS = {".log"}

    c.run(f"sudo mkdir -p {REMOTE_DIR} && sudo chown $USER:$USER {REMOTE_DIR}")

    sftp = c.sftp()

    def _ensure_remote_dir(remote_path):
        try:
            sftp.stat(remote_path)
        except FileNotFoundError:
            sftp.mkdir(remote_path)

    def _upload_tree(local_dir: pathlib.Path, remote_base: str):
        for item in sorted(local_dir.iterdir()):
            if item.name in SKIP_DIRS or item.suffix in SKIP_EXTS:
                continue
            remote_path = f"{remote_base}/{item.name}"
            if item.is_dir():
                _ensure_remote_dir(remote_path)
                _upload_tree(item, remote_path)
            else:
                sftp.put(str(item), remote_path)
                print(f"  -> {remote_path}")

    _upload_tree(hub_dir, REMOTE_DIR)
    sftp.close()
    print(f"[ok] Code synced to {REMOTE_DIR}")


@task
def install_node(c):
    """Install Node.js on the Pi using NodeSource (skips if >= min version)."""
    result = c.run("node --version", warn=True)
    if result.ok:
        ver = result.stdout.strip().lstrip("v")
        major = int(ver.split(".")[0]) if ver else 0
        if major >= int(NODE_VERSION):
            print(f"[ok] Node.js {ver} already installed (>= {NODE_VERSION})")
            return

    print(f"[..] Installing Node.js {NODE_VERSION}...")
    c.run(
        f"curl -fsSL https://deb.nodesource.com/setup_{NODE_VERSION}.x | sudo -E bash -",
        pty=True
    )
    c.run("sudo apt-get install -y nodejs", pty=True)
    print(f"[ok] Node.js installed: {c.run('node --version').stdout.strip()}")


@task
def install_deps(c):
    """Run npm install on Pi."""
    c.run(f"cd {REMOTE_DIR} && npm install --production=false")
    print("[ok] Dependencies installed")


@task
def build(c):
    """Compile TypeScript on Pi."""
    c.run(f"cd {REMOTE_DIR} && npm run build")
    print("[ok] Build complete")


@task
def install_service(c):
    """Install systemd service for hub."""
    node_path = c.run("which node").stdout.strip()
    username = c.run("whoami").stdout.strip()

    service_content = (
        "[Unit]\n"
        "Description=Desktop Commander Remote Hub\n"
        "After=network-online.target tailscaled.service\n"
        "Wants=network-online.target\n"
        "\n"
        "[Service]\n"
        f"Type=simple\n"
        f"User={username}\n"
        f"WorkingDirectory={REMOTE_DIR}\n"
        f"ExecStart={node_path} dist/index.js\n"
        "Restart=always\n"
        "RestartSec=5\n"
        f"Environment=PORT={HUB_PORT}\n"
        f"Environment=WS_PORT={WS_PORT}\n"
        "Environment=NODE_ENV=production\n"
        "StandardOutput=journal\n"
        "StandardError=journal\n"
        "\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    )

    # Write via heredoc to avoid quoting issues
    c.run(
        f"sudo tee /etc/systemd/system/{SERVICE_NAME}.service > /dev/null << 'SVCEOF'\n"
        f"{service_content}SVCEOF"
    )
    c.run("sudo systemctl daemon-reload")
    print(f"[ok] systemd service installed: {SERVICE_NAME}")


@task
def status(c):
    """Show service status and recent logs."""
    c.run(f"sudo systemctl status {SERVICE_NAME} --no-pager -l", warn=True)


@task
def logs(c):
    """Tail service logs (Ctrl+C to stop)."""
    c.run(f"sudo journalctl -u {SERVICE_NAME} -f -n 50", pty=True)


@task
def restart(c):
    """Restart the hub service."""
    c.run(f"sudo systemctl restart {SERVICE_NAME}")
    print("[ok] Service restarted")


@task
def stop(c):
    """Stop the hub service."""
    c.run(f"sudo systemctl stop {SERVICE_NAME}")
    print("[ok] Service stopped")


@task
def create_key(c):
    """Show API keys stored on the hub Pi."""
    c.run("cat ~/.desktop-commander-hub/api-keys.json", warn=True)


@task
def show_config(c):
    """Print hub connection info for configuring device clients and Claude Desktop."""
    result = c.run("tailscale ip -4 2>/dev/null || hostname -I | awk '{print $1}'", warn=True)
    tailscale_ip = result.stdout.strip().split('\n')[0]

    keys_result = c.run("cat ~/.desktop-commander-hub/api-keys.json 2>/dev/null", warn=True)
    api_key = "(run after first start)"
    if keys_result.ok:
        import json
        try:
            keys = json.loads(keys_result.stdout)
            if keys:
                api_key = keys[0]["key"]
        except Exception:
            pass

    print("\n--- Desktop Commander Remote Hub ---")
    print(f"Pi:            pk@{tailscale_ip}")
    print(f"MCP SSE:       http://{tailscale_ip}:{HUB_PORT}/sse")
    print(f"Health:        http://{tailscale_ip}:{HUB_PORT}/health")
    print(f"Device WS:     ws://{tailscale_ip}:{WS_PORT}")
    print(f"API Key:       {api_key}")
    print()
    print("Device client .env:")
    print(f"  DC_HUB_URL=ws://{tailscale_ip}:{WS_PORT}")
    print(f"  DC_HUB_API_KEY={api_key}")
    print()
    print("claude_desktop_config.json:")
    print('  "desktop-commander-remote": {')
    print('    "type": "sse",')
    print(f'    "url": "http://{tailscale_ip}:{HUB_PORT}/sse"')
    print('  }')
    print()


# =============================================================================
# DEVICE CLIENT DEPLOYMENT
# =============================================================================

def _push_device_code(c, remote_dir: str):
    """Upload device client source to a remote host via SFTP."""
    import pathlib
    device_src = pathlib.Path(__file__).parent.parent / "device"
    SKIP = {"node_modules", "dist", ".git", ".env", ".env.example"}

    sftp = c.sftp()

    def _ensure(path):
        try:
            sftp.stat(path)
        except FileNotFoundError:
            sftp.mkdir(path)

    def _upload(local: pathlib.Path, remote: str):
        for item in sorted(local.iterdir()):
            if item.name in SKIP:
                continue
            rpath = f"{remote}/{item.name}"
            if item.is_dir():
                _ensure(rpath)
                _upload(item, rpath)
            else:
                sftp.put(str(item), rpath)
                print(f"  -> {rpath}")

    _ensure(remote_dir)
    _upload(device_src, remote_dir)
    sftp.close()
    print(f"[ok] Device code synced to {remote_dir}")


@task
def deploy_device(c):
    """Deploy device client to a remote host (Mac or Linux) and register with hub.

    Mac:   fab -H k@100.76.176.119 deploy-device
    Linux: fab -H user@host deploy-device
    """
    uname = c.run("uname -s", hide=True).stdout.strip()
    device_name = c.run("hostname -s", hide=True, warn=True).stdout.strip() or c.host

    is_mac = (uname == "Darwin")
    remote_dir = f"/Users/{c.user}/dc-remote-device" if is_mac else DEVICE_DIR
    node_cmd = "export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH && node" if is_mac else "node"
    npm_cmd = "export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH && npm" if is_mac else "npm"

    print(f"[..] Deploying device client to {device_name} ({uname}) at {remote_dir}")

    # Ensure Node.js is present
    node_check = c.run(f"{'export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH && ' if is_mac else ''}node --version", warn=True, hide=True)
    if not node_check.ok:
        if is_mac:
            print("[!!] Node.js not found on Mac. Install via: brew install node")
            return
        else:
            install_node(c)

    # Install Desktop Commander globally so device client can find it without npx
    print("[..] Installing desktop-commander globally...")
    c.run(f"{'export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH && ' if is_mac else ''}"
          f"npm install -g @wonderwhy-er/desktop-commander 2>&1 | tail -3", warn=True)

    # Push code
    if not is_mac:
        c.run(f"sudo mkdir -p {remote_dir} && sudo chown $USER:$USER {remote_dir}")
    _push_device_code(c, remote_dir)

    # Build
    c.run(f"cd {remote_dir} && {npm_cmd} install --production=false 2>&1 | tail -5")
    c.run(f"cd {remote_dir} && {npm_cmd} run build")
    print("[ok] Device client built")

    # Install service
    node_path = c.run(
        f"{'export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH && ' if is_mac else ''}which node",
        hide=True
    ).stdout.strip()

    if is_mac:
        _install_launchd(c, remote_dir, node_path, device_name)
    else:
        _install_systemd_device(c, remote_dir, node_path, device_name)

    print(f"[ok] {device_name} registered with hub at {HUB_WS_URL}")


def _install_launchd(c, remote_dir: str, node_path: str, device_name: str):
    """Install a launchd plist so the device client starts on login (macOS)."""
    label = "com.dc-remote.device"
    plist_path = f"/Users/{c.user}/Library/LaunchAgents/{label}.plist"
    log_dir = f"/Users/{c.user}/Library/Logs"

    plist = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        '<plist version="1.0"><dict>\n'
        f'  <key>Label</key><string>{label}</string>\n'
        '  <key>ProgramArguments</key><array>\n'
        f'    <string>{node_path}</string>\n'
        f'    <string>{remote_dir}/dist/index.js</string>\n'
        '  </array>\n'
        '  <key>EnvironmentVariables</key><dict>\n'
        f'    <key>DC_HUB_URL</key><string>{HUB_WS_URL}</string>\n'
        f'    <key>DC_HUB_API_KEY</key><string>{HUB_API_KEY}</string>\n'
        f'    <key>DC_DEVICE_NAME</key><string>{device_name}</string>\n'
        '  </dict>\n'
        '  <key>RunAtLoad</key><true/>\n'
        '  <key>KeepAlive</key><true/>\n'
        f'  <key>StandardOutPath</key><string>{log_dir}/dc-remote-device.log</string>\n'
        f'  <key>StandardErrorPath</key><string>{log_dir}/dc-remote-device.err</string>\n'
        '</dict></plist>\n'
    )

    c.run(f"mkdir -p ~/Library/LaunchAgents ~/Library/Logs")
    c.run(f"launchctl unload {plist_path} 2>/dev/null; true")

    # Write plist via heredoc
    c.run(f"cat > {plist_path} << 'PLISTEOF'\n{plist}PLISTEOF")
    c.run(f"launchctl load {plist_path}")
    print(f"[ok] launchd service installed: {label}")
    print(f"     Logs: {log_dir}/dc-remote-device.log")


def _install_systemd_device(c, remote_dir: str, node_path: str, device_name: str):
    """Install systemd service for the device client (Linux)."""
    svc = "dc-remote-device"
    username = c.run("whoami", hide=True).stdout.strip()

    unit = (
        "[Unit]\n"
        "Description=Desktop Commander Remote Device\n"
        "After=network-online.target\n\n"
        "[Service]\n"
        f"Type=simple\nUser={username}\n"
        f"WorkingDirectory={remote_dir}\n"
        f"ExecStart={node_path} dist/index.js\n"
        "Restart=always\nRestartSec=5\n"
        f"Environment=DC_HUB_URL={HUB_WS_URL}\n"
        f"Environment=DC_HUB_API_KEY={HUB_API_KEY}\n"
        f"Environment=DC_DEVICE_NAME={device_name}\n"
        "StandardOutput=journal\nStandardError=journal\n\n"
        "[Install]\nWantedBy=multi-user.target\n"
    )

    c.run(f"sudo tee /etc/systemd/system/{svc}.service > /dev/null << 'SVCEOF'\n{unit}SVCEOF")
    c.run("sudo systemctl daemon-reload")
    c.run(f"sudo systemctl enable {svc}")
    c.run(f"sudo systemctl restart {svc}")
    print(f"[ok] systemd service installed and started: {svc}")


@task
def device_logs(c):
    """Tail device client logs on a remote host."""
    uname = c.run("uname -s", hide=True).stdout.strip()
    if uname == "Darwin":
        c.run(f"tail -f ~/Library/Logs/dc-remote-device.log", pty=True)
    else:
        c.run("sudo journalctl -u dc-remote-device -f -n 50", pty=True)


@task
def setup_windows(c=None):
    """Build and start the device client on this Windows machine (local, no -H needed)."""
    import pathlib, subprocess

    device_dir = pathlib.Path(__file__).parent.parent / "device"
    print(f"[..] Building device client in {device_dir}")

    subprocess.run(["npm", "install"], cwd=device_dir, check=True)
    subprocess.run(["npm", "run", "build"], cwd=device_dir, check=True)
    print("[ok] Device client built")
    print()
    print("To start (runs in foreground):")
    print(f"  cd {device_dir} && npm start")
    print()
    print("To run as a Windows scheduled task (starts on login):")
    task_cmd = (
        f'schtasks /create /tn "DC-Remote-Device" /sc ONLOGON /delay 0001:00 '
        f'/tr "node {device_dir}\\\\dist\\\\index.js" /f'
    )
    print(f"  {task_cmd}")


# =============================================================================
# DOCKER / CLOUD DEPLOYMENT
# =============================================================================

DOCKER_HUB_DIR = "/opt/dc-remote-hub"      # where docker-compose.yml lives on remote


def _install_docker(c):
    """Install Docker + Compose plugin if not present (Debian/Ubuntu)."""
    result = c.run("docker --version", warn=True, hide=True)
    if result.ok:
        print(f"[ok] Docker already installed: {result.stdout.strip()}")
        return
    print("[..] Installing Docker...")
    c.run("curl -fsSL https://get.docker.com | sudo sh", pty=True)
    c.run(f"sudo usermod -aG docker {c.run('whoami', hide=True).stdout.strip()}")
    print("[ok] Docker installed (re-login may be needed for group membership)")


@task
def deploy_docker(c):
    """Deploy hub as Docker container with Tailscale sidecar on a cloud VM.

    Requires hub/.env to exist with TS_AUTHKEY set.

    fab -H user@cloud-ip deploy-docker
    """
    import pathlib

    hub_dir = pathlib.Path(__file__).parent.parent / "hub"
    env_file = hub_dir / ".env"

    if not env_file.exists():
        print("[!!] hub/.env not found. Copy hub/.env.example and fill in TS_AUTHKEY.")
        return

    _install_docker(c)

    # Push hub directory (source + compose + dockerfile)
    c.run(f"mkdir -p {DOCKER_HUB_DIR}")
    sftp = c.sftp()

    SKIP = {"node_modules", "dist", ".git"}
    import pathlib as _pl

    def _ensure(p):
        try:
            sftp.stat(p)
        except FileNotFoundError:
            sftp.mkdir(p)

    def _upload(local: _pl.Path, remote: str):
        for item in sorted(local.iterdir()):
            if item.name in SKIP:
                continue
            rp = f"{remote}/{item.name}"
            if item.is_dir():
                _ensure(rp)
                _upload(item, rp)
            else:
                sftp.put(str(item), rp)
                print(f"  -> {rp}")

    _upload(hub_dir, DOCKER_HUB_DIR)
    sftp.close()
    print(f"[ok] Hub code pushed to {DOCKER_HUB_DIR}")

    # Build and start
    c.run(f"cd {DOCKER_HUB_DIR} && docker compose --profile cloud build --no-cache")
    c.run(f"cd {DOCKER_HUB_DIR} && docker compose --profile cloud up -d")
    print("[ok] Hub containers started (cloud profile: hub + tailscale)")
    _docker_status_cmd(c)


@task
def docker_update(c):
    """Rebuild hub image and do a rolling restart on the cloud VM."""
    _push_hub_source(c)
    c.run(f"cd {DOCKER_HUB_DIR} && docker compose --profile cloud build hub")
    c.run(f"cd {DOCKER_HUB_DIR} && docker compose --profile cloud up -d --no-deps hub")
    print("[ok] Hub updated")


@task
def docker_logs(c):
    """Tail hub and tailscale container logs."""
    c.run(f"cd {DOCKER_HUB_DIR} && docker compose --profile cloud logs -f --tail=50", pty=True)


@task
def docker_status(c):
    """Show Docker container status on the cloud VM."""
    _docker_status_cmd(c)


def _docker_status_cmd(c):
    c.run(f"cd {DOCKER_HUB_DIR} && docker compose --profile cloud ps", warn=True)
    c.run(f"docker exec dc-remote-hub-hub-1 wget -qO- http://localhost:3000/health 2>/dev/null || true",
          warn=True)


def _push_hub_source(c):
    """Push only the source files (not .env) for a rebuild."""
    import pathlib as _pl
    hub_dir = _pl.Path(__file__).parent.parent / "hub"
    SKIP = {"node_modules", "dist", ".git", ".env"}
    sftp = c.sftp()

    def _ensure(p):
        try:
            sftp.stat(p)
        except FileNotFoundError:
            sftp.mkdir(p)

    def _upload(local: _pl.Path, remote: str):
        for item in sorted(local.iterdir()):
            if item.name in SKIP:
                continue
            rp = f"{remote}/{item.name}"
            if item.is_dir():
                _ensure(rp)
                _upload(item, rp)
            else:
                sftp.put(str(item), rp)

    _upload(hub_dir, DOCKER_HUB_DIR)
    sftp.close()
