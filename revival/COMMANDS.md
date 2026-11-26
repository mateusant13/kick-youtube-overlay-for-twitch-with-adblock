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
- `fast_test`: `# UNMEASURED — fill with <15s incremental test command`
- `offline_twin`: `# UNMEASURED — fill with harness/twins/ replay command`
- `smoke_e2e`: `# UNMEASURED — fill with real user journey smoke command`
