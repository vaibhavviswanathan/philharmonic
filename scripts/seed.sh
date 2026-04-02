#!/usr/bin/env bash
# Seed script: delete all projects and recreate with test tasks.
# Usage: ./scripts/seed.sh [API_URL]
set -euo pipefail

API="${1:-https://phil.veredaspartners.com}"

echo "==> Cleaning up existing projects..."
projects=$(curl -sf "$API/v1/projects" | python3 -c "import sys,json; [print(p['id']) for p in json.load(sys.stdin)]" 2>/dev/null || true)
for pid in $projects; do
  echo "    Deleting project $pid"
  curl -sf -X DELETE "$API/v1/projects/$pid" > /dev/null
done

echo "==> Creating project: phil"
PROJECT_ID=$(curl -sf -X POST "$API/v1/projects" \
  -H "Content-Type: application/json" \
  -d '{"name":"phil","repoUrl":"https://github.com/vaibhavviswanathan/philharmonic"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "    Project ID: $PROJECT_ID"

echo "==> Creating seed tasks..."

create_task() {
  local desc="$1"
  local backlog="${2:-true}"
  local id=$(curl -sf -X POST "$API/v1/tasks" \
    -H "Content-Type: application/json" \
    -d "{\"projectId\":\"$PROJECT_ID\",\"description\":\"$desc\",\"backlog\":$backlog}" \
    | python3 -c "import sys,json; t=json.load(sys.stdin); print(t['id'])")
  echo "    $id | $desc"
}

create_task "I don't want to enter to a list of all projects. Push me to the first project by default."
create_task "If i refresh the page, I end up at the start. I want the state to be persisted via the URL so I can share links to tasks."
create_task "Create a notion style UI"

echo ""
echo "==> Done! Seeded project '$PROJECT_ID' with 3 tasks."
echo "    Dashboard: https://phil-dashboard.pages.dev"
echo "    API: $API"
