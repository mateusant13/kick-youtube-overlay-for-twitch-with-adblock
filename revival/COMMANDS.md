# Verified Command Sheet — kicktwitchyoutube_instagram (<= 30 lines)

- `bootstrap`: `python "C:\Users\Administrador\.agents\skills\project-revival\scripts\revival_bootstrap.py" --project . --goal "..."`
- `checkpoint`: `python "C:\Users\Administrador\.agents\skills\project-revival\scripts\git_checkpoint.py" snapshot --repo . --name <label>`
- `worktree_new`: `python "C:\Users\Administrador\.agents\skills\project-revival\scripts\git_checkpoint.py" wt-new --repo . --lane <name>`
- `worktree_land`: `python "C:\Users\Administrador\.agents\skills\project-revival\scripts\git_checkpoint.py" wt-land --repo . --worktree <wt> --receipt <r.json> --cleanup`
- `feature_sync`: `python "C:\Users\Administrador\.agents\skills\project-revival\scripts\feature_map_sync.py" --repo .`
- `feature_gate`: `python "C:\Users\Administrador\.agents\skills\project-revival\scripts\feature_map_sync.py" --repo . --gate`
- `bench_gate`: `python "C:\Users\Administrador\.agents\skills\project-revival\scripts\benchmark_history.py" run --repo . --label <wave> --gate --blast-radius`
- `sliders`: `python "C:\Users\Administrador\.agents\skills\project-revival\scripts\slider_scorecard.py" report --repo .`
- `friction_gate`: `python "C:\Users\Administrador\.agents\skills\project-revival\scripts\loop_friction_audit.py" measure --repo . --gate`
- `codeintel_health`: `codeintel health . --panorama --json`
- `codeintel_trace`: `codeintel trace run --json -- <target>`
- `fast_test`: `node _tools/ko-census.mjs --gate && node kick-overlay/bridge-handshake-test.cjs && node --check kick-overlay/twitch-adblock.js` (measured 0.6 s; the per-edit loop for any change to the ad path or the bridge — the three cheapest instruments that can fail on such an edit)
- `offline_twin`: `KO_REPLICA_SEG=2 KO_REPLICA_MEDIA=G:/Temp/ko-replica/media node _tools/ko-replica/run.mjs --scenario _tools/ko-replica/scenarios/dev-preroll-hold.json --replica-port 8443` (a whole pod, no live stream, no owner; `--no-ext` inverts the pixel expectations, so the same run without the extension must FAIL)
- `smoke_e2e`: `node _tools/ko-load-check.mjs && node _tools/ko-verify.mjs` (the project gate; the load reading is the `&&` left side because the gate is the box's one heavy step — measured 365 s at 0.8.126)
