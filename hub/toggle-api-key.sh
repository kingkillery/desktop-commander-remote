#!/bin/bash
# Toggle between personal and console API keys
# Usage:
#   ./toggle-api-key.sh personal   - use your real API key
#   ./toggle-api-key.sh console    - use console/temp key
#   source ./toggle-api-key.sh      - export to current shell

cd "$(dirname "$0")"

MODE="${1:-}"

if [ "$MODE" = "personal" ] || [ -z "$MODE" ]; then
    if [ ! -f ".env.personal" ]; then
        echo "Error: .env.personal not found. Create it with your API key."
        exit 1
    fi
    cp .env.personal .env.active
    echo "Switched to PERSONAL API key"
elif [ "$MODE" = "console" ]; then
    if [ ! -f ".env.console" ]; then
        echo "Error: .env.console not found."
        exit 1
    fi
    cp .env.console .env.active
    echo "Switched to CONSOLE API key"
elif [ "$MODE" = "export" ]; then
    # Export to current shell (call with: source ./toggle-api-key.sh export)
    if [ -f ".env.active" ]; then
        export $(grep -v '^#' .env.active | xargs)
        echo "Exported ANTHROPIC_API_KEY to current shell"
        echo "Current: ${ANTHROPIC_API_KEY:0:20}..."
    else
        echo "Error: .env.active not found. Run with 'personal' or 'console' first."
        exit 1
    fi
    return 0 2>/dev/null || exit 0
else
    echo "Usage:"
    echo "  ./toggle-api-key.sh personal   - use your real API key"
    echo "  ./toggle-api-key.sh console    - use console/temp key"
    echo "  source ./toggle-api-key.sh export  - export active key to shell"
    echo ""
    echo "Current active key:"
    if [ -f ".env.active" ]; then
        grep "ANTHROPIC_API_KEY" .env.active | sed 's/=.*/=****/'
    else
        echo "(none - run './toggle-api-key.sh personal' first)"
    fi
    exit 1
fi

echo "Active key: $(grep "ANTHROPIC_API_KEY" .env.active | sed 's/=.*/=****/')"
