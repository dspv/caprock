# Benchmarks, 2026-10-06

MacBookPro18,3 (Apple M1 Pro, 10 cores, 16 GB), macOS 27.0.1 (26A434), display 1920x1080@1x 100Hz, Now drawing from 'AC Power'. Runs started 2026-10-06 03:24 UTC, 2026-10-06 03:38 UTC, 2026-10-06 03:52 UTC.

| Metric | Budget | run 1 | run 2 | run 3 | Verdict |
|---|---|---|---|---|---|
| Echo p50, any load to 1000 lines/s | ≤ 12 ms | 12 ms | 12 ms | 12 ms | pass |
| Echo p95, any load to 1000 lines/s | ≤ 25 ms | 20 ms | 19 ms | 19 ms | pass |
| Echo p95 in tab A while tab B floods | ≤ 25 ms | 28 ms | 18 ms | 19 ms | mixed |
| Open a session, click to first echo, p50 | ≤ 200 ms | 113 ms | 112 ms | 113 ms | pass |
| Switch to an open tab, to first paint | ≤ 50 ms | 35 ms | 39 ms | 39 ms | pass |
| Cold start to interactive window | ≤ 1.5 s | 1.25 s | 1.08 s | 1.41 s | pass |
| Cold start to first echo in a restored tab | ≤ 2.5 s | 1.72 s | 1.43 s | 1.50 s | pass |
| Memory, all app processes, 1 tab (footprint) | ≤ 250 MB | 181.9 MB | 195.5 MB | 183.6 MB | pass |
| Memory, all app processes, 10 tabs (footprint) | ≤ 450 MB | 310.5 MB | 310.1 MB | 287 MB | pass |
| CPU, window visible, no output | ≤ 1% of one core | 4.7 % | 3.5 % | 1.1 % | fail |
| CPU, window hidden | ≤ 0.2% of one core | 0.44 % | 0.80 % | 0.40 % | fail |
| CPU, one visible tab at 1000 lines/s | ≤ 25% of one core | 2.0 % | 16.5 % | 20.4 % | pass |
| UI long task during the benchmark | none over 100 ms | 66 ms | 133 ms | 62 ms | mixed |
| Daemon restart to live terminal | ≤ 2 s | 480 ms | 468 ms | 406 ms | pass |
| Network back to live terminal (phone) | ≤ 3 s median | 60 ms | 54 ms | 65 ms | pass |
| Half-open connection detected | ≤ 25 s | 22.88 s | 23.78 s | 23.16 s | pass |
| Disk written by the app, per day | ≤ 10 MB | 476.5 MB | 0.0 MB | 0.0 MB | mixed |
| Download size, per OS (macOS, Caprock_0.77.0_universal.dmg) | ≤ 60 MB | 17.4 MB | – | – | pass |

Also measured (no budget row):

- app-r1: memory (footprint) 5 tabs 245.5 MB, 10 tabs after 40 s 311 MB; summed RSS (peak) 1/5/10 tabs 363.4 MB / 400.7 MB / 383.4 MB; open p95 118 ms; switch p95 39 ms; CPU spinner only (visible) 2.2 %, hidden with spinners 1.9 %; disk in the first two minutes 1.3 MB; first launch of a new copy 1.19 s
  - echo at 0 lines/s: p50 12 ms, p95 18 ms, max 25 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
  - echo at 200 lines/s: p50 11 ms, p95 19 ms, max 25 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
  - echo at 1000 lines/s: p50 11 ms, p95 20 ms, max 25 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
- app-r2: memory (footprint) 5 tabs 250.7 MB, 10 tabs after 40 s 288.8 MB; summed RSS (peak) 1/5/10 tabs 290.6 MB / 292.4 MB / 262.2 MB; open p95 225 ms; switch p95 51 ms; CPU spinner only (visible) 2.5 %, hidden with spinners 1.5 %; disk in the first two minutes 1.3 MB; first launch of a new copy 1.37 s
  - echo at 0 lines/s: p50 12 ms, p95 18 ms, max 23 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
  - echo at 200 lines/s: p50 11 ms, p95 18 ms, max 21 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
  - echo at 1000 lines/s: p50 11 ms, p95 19 ms, max 24 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
- app-r3: memory (footprint) 5 tabs 245 MB, 10 tabs after 40 s 292 MB; summed RSS (peak) 1/5/10 tabs 366.9 MB / 373.2 MB / 395.6 MB; open p95 175 ms; switch p95 46 ms; CPU spinner only (visible) 8.5 %, hidden with spinners 1.3 %; disk in the first two minutes 1.4 MB; first launch of a new copy 1.57 s
  - echo at 0 lines/s: p50 12 ms, p95 18 ms, max 30 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
  - echo at 200 lines/s: p50 12 ms, p95 18 ms, max 21 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
  - echo at 1000 lines/s: p50 12 ms, p95 19 ms, max 27 ms, socket p50 2 ms, n 200, timeouts 0, input keydown
- phone-r1: chat open on wifi: p50 47 ms, p95 69 ms ([69, 48, 47, 46, 47, 47, 46, 47])
- phone-r1: chat open on cellular: p50 147 ms, p95 162 ms ([146, 147, 146, 146, 148, 147, 146, 162])
- phone-r1: back to live p95 758 ms, max 760 ms, failed 0
  - wifi_off (5 s): 60 ms
  - wifi_off (5 s): 57 ms
  - wifi_off (5 s): 53 ms
  - wifi_off (5 s): 61 ms
  - wifi_off (5 s): 63 ms
  - airplane (60 s): 62 ms
  - wifi_to_cellular (0 s): 390 ms
  - wifi_to_cellular (0 s): 386 ms
  - wifi_to_cellular (0 s): 760 ms
  - wifi_to_cellular (0 s): 758 ms
  - wifi_to_cellular (0 s): 393 ms
  - stall (10 s): 21 ms
  - stall (10 s): 19 ms
  - stall (10 s): 27 ms
  - stall (10 s): 22 ms
  - stall (10 s): 14 ms
  - half_open (40 s): 56 ms, detected after 22.05 s, redialled after 22.05 s
  - half_open (40 s): 58 ms, detected after 22.88 s, redialled after 22.88 s
- phone-r2: chat open on wifi: p50 47 ms, p95 64 ms ([56, 46, 45, 48, 47, 64, 45, 45])
- phone-r2: chat open on cellular: p50 147 ms, p95 161 ms ([147, 146, 145, 147, 147, 161, 146, 146])
- phone-r2: back to live p95 394 ms, max 398 ms, failed 0
  - wifi_off (5 s): 57 ms
  - wifi_off (5 s): 67 ms
  - wifi_off (5 s): 39 ms
  - wifi_off (5 s): 54 ms
  - wifi_off (5 s): 53 ms
  - airplane (60 s): 86 ms
  - wifi_to_cellular (0 s): 398 ms
  - wifi_to_cellular (0 s): 385 ms
  - wifi_to_cellular (0 s): 394 ms
  - wifi_to_cellular (0 s): 394 ms
  - wifi_to_cellular (0 s): 389 ms
  - stall (10 s): 23 ms
  - stall (10 s): 29 ms
  - stall (10 s): 24 ms
  - stall (10 s): 25 ms
  - stall (10 s): 24 ms
  - half_open (40 s): 42 ms, detected after 23.04 s, redialled after 23.04 s
  - half_open (40 s): 53 ms, detected after 23.78 s, redialled after 23.78 s
- phone-r3: chat open on wifi: p50 46 ms, p95 69 ms ([69, 45, 45, 46, 45, 47, 45, 47])
- phone-r3: chat open on cellular: p50 149 ms, p95 162 ms ([162, 147, 147, 147, 162, 149, 147, 162])
- phone-r3: back to live p95 406 ms, max 760 ms, failed 0
  - wifi_off (5 s): 69 ms
  - wifi_off (5 s): 70 ms
  - wifi_off (5 s): 65 ms
  - wifi_off (5 s): 59 ms
  - wifi_off (5 s): 54 ms
  - airplane (60 s): 67 ms
  - wifi_to_cellular (0 s): 406 ms
  - wifi_to_cellular (0 s): 260 ms
  - wifi_to_cellular (0 s): 392 ms
  - wifi_to_cellular (0 s): 391 ms
  - wifi_to_cellular (0 s): 760 ms
  - stall (10 s): 28 ms
  - stall (10 s): 21 ms
  - stall (10 s): 23 ms
  - stall (10 s): 28 ms
  - stall (10 s): 27 ms
  - half_open (40 s): 57 ms, detected after 23.16 s, redialled after 23.16 s
  - half_open (40 s): 55 ms, detected after 22.98 s, redialled after 22.98 s

- app-r1: 1-minute load average before each phase 5.0–6.9 on 10 cores
- app-r2: 1-minute load average before each phase 4.5–5.8 on 10 cores
- app-r3: 1-minute load average before each phase 4.8–7.0 on 10 cores
- phone-r1: 1-minute load average before each phase 7.0–8.3 on 10 cores
- phone-r2: 1-minute load average before each phase 5.6–6.7 on 10 cores
- phone-r3: 1-minute load average before each phase 4.4–5.3 on 10 cores
