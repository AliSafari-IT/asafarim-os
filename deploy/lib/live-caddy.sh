#!/usr/bin/env bash
# asafarim.site before the edge cutover (#97), sourced by deploy/vps-deploy.sh (not executed).
#
#   publish_live_site <site-file>
#
# Until the shared edge's phase 3 cutover (asafarim-platform #770), the Caddy that owns 80/443 is
# asafarim-com's own (compose project asafarim-com, service caddy, config in
# <asafarim-com checkout>/infra/caddy). Publishing to the edge only stores the file there. So, like
# asafarim-platform's igs_publish_live, this installs the site file as that Caddy's
# sites.local/asafarim-os.caddy (git-ignored in asafarim-platform, imported by its Caddyfile):
# validate the WHOLE live config with the file in, using the live Caddy's own image → swap, keeping the
# previous file → graceful reload → check the running Caddy reads this exact file. Any failure restores
# the previous file (or removes ours) and reloads again.
#
# After the cutover (no asafarim-com Caddy, an edge container running) it does nothing: the edge publish
# already made the file live. With neither running, nothing serves 443, and it fails.
#
# Expects LIVE_REPO_DIR (the asafarim-com checkout, default /var/repos/asafarim-com).

publish_live_site() {
  local site_file="$1" live_dir live_id edge_id
  live_dir="${LIVE_REPO_DIR:-/var/repos/asafarim-com}/infra/caddy"
  live_id="$(docker ps -q --filter label=com.docker.compose.project=asafarim-com --filter label=com.docker.compose.service=caddy | head -n 1)"
  if [[ -z "$live_id" ]]; then
    edge_id="$(docker compose -p edge ps -q caddy 2>/dev/null | head -n 1 || true)"
    if [[ -n "$edge_id" ]]; then
      echo "live: the shared edge serves 443 (after the cutover); the edge publish is enough."
      return 0
    fi
    echo "live: no running asafarim-com Caddy and no edge container: nothing serves 443." >&2
    return 1
  fi
  if ! docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$live_id" | grep -qw edge_net; then
    echo "live: the live Caddy is not on edge_net, so it can't reach os-site. Once, with no restart:" >&2
    echo "  docker network connect edge_net ${live_id:0:12}" >&2
    return 1
  fi
  [[ -f "${live_dir}/Caddyfile" ]] || { echo "live: ${live_dir}/Caddyfile is missing (set LIVE_REPO_DIR to the asafarim-com checkout)." >&2; return 1; }

  (
    local dest="${live_dir}/sites.local/asafarim-os.caddy" prev candidate image had_prev=false host_sum live_sum
    prev="${dest}.prev"
    # The same lock igs-deploy.sh takes for the live Caddy's sites.local/: one swap and reload at a time.
    exec 9>"${LIVE_REPO_DIR:-/var/repos/asafarim-com}/.igs-live-site.lock"
    flock -w 300 9 || { echo "live: the live site lock is busy" >&2; exit 75; }

    # 1. Validate the WHOLE live config with our file in, with the live Caddy's image.
    candidate="$(mktemp -d)"
    trap 'rm -rf "$candidate" "$candidate.log"' EXIT
    cp -R "${live_dir}/." "$candidate/"
    mkdir -p "$candidate/sites.local"
    cp "$site_file" "$candidate/sites.local/asafarim-os.caddy"
    image="$(docker inspect -f '{{.Config.Image}}' "$live_id")"
    if ! docker run --rm -v "$candidate:/etc/caddy:ro" "$image" \
        caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$candidate.log" 2>&1; then
      echo "live: the site file is invalid with the live Caddy config (does its Caddyfile still define asafarim.site? asafarim-platform#837 removes it); live config untouched." >&2
      tail -n 20 "$candidate.log" >&2 || true
      exit 1
    fi

    # 2. Swap atomically, keeping the previous file.
    mkdir -p "${live_dir}/sites.local"
    if [[ -f "$dest" ]]; then cp -p "$dest" "$prev"; had_prev=true; fi
    cp "$site_file" "${dest}.next"
    mv -f "${dest}.next" "$dest"

    restore() {
      echo "live: $1; restoring the previous live site file." >&2
      if [[ "$had_prev" == true ]]; then mv -f "$prev" "$dest"; else rm -f "$dest"; fi
      docker exec "$live_id" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile ||
        echo "live: reload after the restore failed too; the live Caddy keeps its last loaded config. Investigate now." >&2
      exit 1
    }

    # 3. Graceful reload, then prove the running Caddy reads this exact file.
    docker exec "$live_id" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || restore "caddy reload failed"
    host_sum="$(sha256sum "$dest" | awk '{print $1}')"
    live_sum="$(docker exec "$live_id" sha256sum /etc/caddy/sites.local/asafarim-os.caddy | awk '{print $1}' || true)"
    [[ "$host_sum" == "$live_sum" ]] || restore "the live Caddy does not see the new file"
    echo "live: the live Caddy serves sites.local/asafarim-os.caddy (sha256 ${host_sum:0:16})"
  )
}
