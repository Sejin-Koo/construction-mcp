# construction-mcp

건설·건축 현장과 시공사를 조회하는 MCP 서버입니다. 2026-10-08 `public-data-portal-mcp`에서 건설 도구 17개를 그대로 옮겨 분리했습니다(분리 전후 같은 인자로 17개 도구를 호출해 응답 일치를 확인).

## 엔드포인트

`https://<배포 도메인>/api/mcp?k=<게이트키>` — 접근 게이트가 걸려 있습니다(`MCP_GATE_KEYS`, `MCP_GATE_MODE=enforce`).

## 도구 (17개)

| 묶음 | 도구 |
|---|---|
| 키스콘 건설정보 | `search_construction_firms`, `search_construction_sanctions`, `get_construction_notice_stats` |
| 건설CALS | `search_cals_construction`, `get_cals_construction_detail`, `search_cals_contractor`, `search_cals_quality_tests`, `search_cals_project_evaluation`, `search_cals_road_occupancy` |
| 건축HUB 건축인허가 | `scan_arch_permits`, `search_arch_permits`, `get_arch_permit_detail`, `search_arch_aux_registers` |
| 주택인허가·청약홈 | `scan_national_housing_pipeline`, `search_housing_permits`, `search_housing_sales`, `scan_construction_pipeline` |

공공 낙찰정보(`search_narajangteo_scsbid` 등)와 사업자번호 해석기(`resolve_bizno`)는 `public-data-portal-mcp`에 남아 있습니다.

## 환경변수

| 이름 | 용도 |
|---|---|
| `DATA_PORTAL_KEY` | 공공데이터포털 공통 인증키(건축HUB·주택인허가·청약홈·키스콘) |
| `CALS_KEY` | 건설CALS(calspia.go.kr) 인증키 — 공공데이터포털 키와 별개 |
| `DART_API_KEY` | 사업자번호 해석기 1단계(DART) |
| `NIMBLE_API_KEY` | 사업자번호 해석기 3단계(국내 IP 경유 조회) |
| `MCP_GATE_KEYS`, `MCP_GATE_MODE` | 접근 게이트 |

## 데이터와 자동 갱신

| 파일 | 갱신 |
|---|---|
| `data/housing_permits.json.gz` | 이 저장소 `refresh-housing-permits.yml` — 매월 마지막 일요일 |
| `data/corp_name_index.json.gz`, `data/kiscon_bizno_index.json.gz` | 원본은 `public-data-portal-mcp`의 Actions가 갱신하고, 이 저장소 `sync-shared.yml`이 매일 06:00 KST에 받아 옴 |

`lib/pdp_client.js`와 `lib/bizno_resolver.js`는 `public-data-portal-mcp`가 원본입니다. 워크플로 `sync-shared.yml`이 매일 06:00 KST에 원본을 받아 서버가 정상 기동하는지(`buildServer`) 확인한 뒤에만 커밋합니다. **이 저장소에서 두 파일을 직접 고치지 마십시오** — 다음 동기화 때 원본으로 덮입니다. 공통 로직은 원본 저장소에서 고치고, 급하면 이 저장소의 Actions에서 워크플로를 수동 실행(workflow_dispatch)하십시오.

## 로컬 점검

`smoke_archhub.mjs`, `smoke_cals.mjs`, `smoke_housing.mjs` — 환경변수를 넣고 `node <파일>`로 실행합니다.
