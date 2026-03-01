#!/usr/bin/env bash
#
# Beadbox installation script
# Usage: curl -fsSL https://raw.githubusercontent.com/beadbox/beadbox/main/scripts/install.sh | bash
#
# Installs Beadbox (GUI for the beads issue tracker) on macOS or Linux.
# macOS: downloads DMG, copies .app to /Applications/
# Linux: downloads AppImage to ~/.local/bin/, creates .desktop entry
#

set -e

GITHUB_REPO="beadbox/beadbox"
APP_NAME="Beadbox"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}==>${NC} $1"
}

log_success() {
    echo -e "${GREEN}==>${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}==>${NC} $1"
}

log_error() {
    echo -e "${RED}Error:${NC} $1" >&2
}

# Detect OS and architecture
detect_platform() {
    local os arch

    case "$(uname -s)" in
        Darwin)
            os="darwin"
            ;;
        Linux)
            os="linux"
            ;;
        *)
            log_error "Unsupported operating system: $(uname -s)"
            log_error "Beadbox supports macOS and Linux."
            exit 1
            ;;
    esac

    case "$(uname -m)" in
        x86_64|amd64)
            arch="x86_64"
            ;;
        aarch64|arm64)
            arch="arm64"
            ;;
        *)
            log_error "Unsupported architecture: $(uname -m)"
            exit 1
            ;;
    esac

    echo "${os}_${arch}"
}

# Download a URL to a file, using curl or wget
download() {
    local url="$1"
    local output="$2"

    if command -v curl &>/dev/null; then
        curl -fsSL -o "$output" "$url"
    elif command -v wget &>/dev/null; then
        wget -qO "$output" "$url"
    else
        log_error "Neither curl nor wget found. Please install one of them."
        exit 1
    fi
}

# Fetch a URL and print to stdout
fetch() {
    local url="$1"

    if command -v curl &>/dev/null; then
        curl -fsSL "$url"
    elif command -v wget &>/dev/null; then
        wget -qO- "$url"
    else
        log_error "Neither curl nor wget found. Please install one of them."
        exit 1
    fi
}

# List all asset names from the release JSON
list_assets() {
    local release_json="$1"
    echo "$release_json" | grep -o '"name": *"[^"]*"' | sed 's/"name": *"//;s/"//'
}

# Find a matching asset name in the release JSON
find_asset() {
    local release_json="$1"
    local pattern="$2"

    list_assets "$release_json" | grep "$pattern" | head -1
}

# Install on macOS: download DMG, mount, copy .app, unmount
install_macos() {
    local version="$1"
    local arch="$2"
    local release_json="$3"

    # Map architecture name to match release asset naming
    local asset_arch="$arch"
    if [ "$arch" = "x86_64" ]; then
        asset_arch="x64"
    fi

    # Find the DMG asset for this architecture
    local asset_name
    asset_name=$(find_asset "$release_json" "${APP_NAME}-${version#v}-${asset_arch}\.dmg")

    if [ -z "$asset_name" ]; then
        # Try without version (latest alias)
        asset_name=$(find_asset "$release_json" "${APP_NAME}-latest-${asset_arch}\.dmg")
    fi

    if [ -z "$asset_name" ]; then
        log_error "No DMG found for macOS ${arch} in release ${version}"
        log_error "Available assets:"
        echo "$release_json" | grep -o '"name": *"[^"]*"' | sed 's/"name": *"//;s/"//' | sed 's/^/  /' >&2
        exit 1
    fi

    local download_url="https://github.com/${GITHUB_REPO}/releases/download/${version}/${asset_name}"
    local tmp_dir
    tmp_dir=$(mktemp -d)
    local dmg_path="${tmp_dir}/${asset_name}"

    log_info "Downloading ${asset_name}..."
    if ! download "$download_url" "$dmg_path"; then
        log_error "Download failed: ${download_url}"
        rm -rf "$tmp_dir"
        exit 1
    fi

    log_info "Mounting DMG..."
    local mount_point="${tmp_dir}/dmg_mount"
    mkdir -p "$mount_point"

    if ! hdiutil attach "$dmg_path" -mountpoint "$mount_point" -nobrowse -quiet; then
        log_error "Failed to mount DMG"
        rm -rf "$tmp_dir"
        exit 1
    fi

    # Find the .app bundle inside the mounted DMG
    local app_path
    app_path=$(find "$mount_point" -maxdepth 1 -name "*.app" -print -quit)

    if [ -z "$app_path" ]; then
        log_error "No .app bundle found in DMG"
        hdiutil detach "$mount_point" -quiet 2>/dev/null || true
        rm -rf "$tmp_dir"
        exit 1
    fi

    local app_basename
    app_basename=$(basename "$app_path")
    local install_path="/Applications/${app_basename}"

    # Remove existing installation if present
    if [ -d "$install_path" ]; then
        log_info "Removing existing ${app_basename}..."
        rm -rf "$install_path"
    fi

    log_info "Copying ${app_basename} to /Applications/..."
    if ! cp -R "$app_path" /Applications/; then
        log_error "Failed to copy to /Applications/. You may need to run with sudo."
        hdiutil detach "$mount_point" -quiet 2>/dev/null || true
        rm -rf "$tmp_dir"
        exit 1
    fi

    log_info "Unmounting DMG..."
    hdiutil detach "$mount_point" -quiet 2>/dev/null || true

    # Clean up
    rm -rf "$tmp_dir"

    # Remove quarantine attribute so the app can launch without Gatekeeper warnings
    xattr -rd com.apple.quarantine "$install_path" 2>/dev/null || true

    log_success "${APP_NAME} installed to /Applications/${app_basename}"
    echo ""
    echo "Launch ${APP_NAME} from your Applications folder, Spotlight, or run:"
    echo "  open /Applications/${app_basename}"
    echo ""
}

# Install on Linux: download AppImage, install to ~/.local/bin/, create .desktop entry
install_linux() {
    local version="$1"
    local arch="$2"
    local release_json="$3"

    # Map architecture names for AppImage assets
    local asset_arch="$arch"
    if [ "$arch" = "x86_64" ]; then
        asset_arch="amd64"
    fi

    # Find the AppImage asset matching this architecture
    local asset_name
    asset_name=$(list_assets "$release_json" | grep "\.AppImage" | grep -i "${asset_arch}\|${arch}" | head -1)

    # If arch-specific search failed, try any AppImage
    if [ -z "$asset_name" ]; then
        asset_name=$(list_assets "$release_json" | grep "\.AppImage" | head -1)
    fi

    if [ -z "$asset_name" ]; then
        log_error "No AppImage found for Linux ${arch} in release ${version}"
        log_error "Available assets:"
        echo "$release_json" | grep -o '"name": *"[^"]*"' | sed 's/"name": *"//;s/"//' | sed 's/^/  /' >&2
        exit 1
    fi

    local download_url="https://github.com/${GITHUB_REPO}/releases/download/${version}/${asset_name}"
    local install_dir="$HOME/.local/bin"
    local install_path="${install_dir}/beadbox"

    mkdir -p "$install_dir"

    log_info "Downloading ${asset_name}..."
    if ! download "$download_url" "$install_path"; then
        log_error "Download failed: ${download_url}"
        rm -f "$install_path"
        exit 1
    fi

    chmod +x "$install_path"
    log_success "AppImage installed to ${install_path}"

    # Install icon and create .desktop entry for app launchers
    install_icon
    create_desktop_entry "$install_path"

    # Check PATH
    if [[ ":$PATH:" != *":${install_dir}:"* ]]; then
        log_warning "${install_dir} is not in your PATH"
        echo ""
        echo "Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
        echo "  export PATH=\"\$PATH:${install_dir}\""
        echo ""
    fi

    echo ""
    echo "Launch ${APP_NAME} from your application menu or run:"
    echo "  beadbox"
    echo ""
}

# Install app icon for Linux desktop integration
install_icon() {
    local icon_dir="$HOME/.local/share/icons/hicolor/256x256/apps"
    local icon_path="${icon_dir}/beadbox.png"

    mkdir -p "$icon_dir"

    local icon_url="https://raw.githubusercontent.com/${GITHUB_REPO}/main/icon-square.png"

    log_info "Installing application icon..."
    if download "$icon_url" "$icon_path"; then
        # Update icon cache if available
        if command -v gtk-update-icon-cache &>/dev/null; then
            gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
        fi
        log_success "Icon installed to ${icon_path}"
    else
        log_warning "Could not download app icon (non-fatal)"
    fi
}

# Create a .desktop file for Linux application menus
create_desktop_entry() {
    local exec_path="$1"
    local desktop_dir="$HOME/.local/share/applications"
    local desktop_file="${desktop_dir}/beadbox.desktop"

    mkdir -p "$desktop_dir"

    cat > "$desktop_file" << EOF
[Desktop Entry]
Type=Application
Name=${APP_NAME}
Comment=GUI for the beads issue tracker
Exec=${exec_path}
Icon=beadbox
Terminal=false
Categories=Development;ProjectManagement;
StartupNotify=true
StartupWMClass=beadbox
EOF

    # Update desktop database if available
    if command -v update-desktop-database &>/dev/null; then
        update-desktop-database "$desktop_dir" 2>/dev/null || true
    fi

    log_success "Desktop entry created at ${desktop_file}"
}

# Main installation flow
main() {
    echo ""
    echo "Beadbox Installer"
    echo ""

    log_info "Detecting platform..."
    local platform
    platform=$(detect_platform)

    local os="${platform%%_*}"
    local arch="${platform#*_}"
    log_info "Platform: ${os} ${arch}"

    # Fetch latest release
    log_info "Fetching latest release..."
    local api_url="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
    local release_json
    release_json=$(fetch "$api_url")

    if [ -z "$release_json" ]; then
        log_error "Failed to fetch release information from GitHub"
        exit 1
    fi

    local version
    version=$(echo "$release_json" | grep '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' | head -1)

    if [ -z "$version" ]; then
        log_error "Failed to determine latest version"
        exit 1
    fi

    log_info "Latest version: ${version}"

    case "$os" in
        darwin)
            install_macos "$version" "$arch" "$release_json"
            ;;
        linux)
            install_linux "$version" "$arch" "$release_json"
            ;;
    esac

    log_success "${APP_NAME} ${version} installed successfully!"
}

main "$@"
