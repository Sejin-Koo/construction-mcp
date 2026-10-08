// construction-mcp — 건설·건축 현장과 시공사 조회 MCP 서버
//
// 2026-10-08 public-data-portal-mcp에서 분리했다. 도구 17개(키스콘 3 · 건설CALS 6 · 건축HUB 4 · 주택인허가/청약홈 4)의
// 코드·입출력은 분리 전과 같다. lib/pdp_client.js·lib/bizno_resolver.js는 원 서버의 사본이므로
// 공통 로직을 고칠 때는 두 저장소를 함께 고칠 것. 사업자번호 색인 2종(data/corp_name_index·kiscon_bizno_index)은
// 원 서버의 Actions가 갱신하고, 이 저장소는 sync-shared 워크플로가 매일 받아 온다.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  searchConstructionFirms,
  searchConstructionSanctions,
  getConstructionNoticeStats,
} from "./kiscon_client.js";
import {
  searchCalsConstruction,
  getCalsConstructionDetail,
  searchCalsContractor,
  searchCalsQualityTests,
  searchCalsProjectEvaluation,
  searchCalsRoadOccupancy,
  DETAIL_SECTION_NAMES,
  QUALITY_DATA_CUTOFF,
  CALS_KEY,
  CALS_KEY_SOURCE,
} from "./cals_client.js";
import {
  scanArchPermits,
  searchArchPermits,
  getArchPermitDetail,
  searchArchAuxRegisters,
  DETAIL_SECTIONS,
  AUX_KINDS,
  ARCHHUB_DATA_LAG,
  TOTAL_BJDONG,
} from "./archhub_client.js";
import { registerHousingTools } from "./housing_client.js";

export const SERVER_VERSION = "1.0.0";

export function buildServer() {
  const server = new McpServer({ name: "construction-mcp", version: SERVER_VERSION });

  server.tool(
    "search_construction_firms",
    "국토교통부 키스콘(KISCON) **건설업체 등록·변동 공시**를 조회합니다. 건설업 신규등록·등록기준사항 " +
      "신고·양도신고·법인합병 신고·상속신고 5종을 한 번에 훑어 업체명·**사업자등록번호**·대표자·업종· " +
      "등록번호·소재지·연락처·공시일을 돌려줍니다. 건설 분야 신규 고객사 발굴이나 거래처 실체 확인에 " +
      "씁니다. " +
      "★ **기간 기반 조회입니다** — sDate·eDate(YYYYMMDD)가 필수이고 2003-01-01 이후 공시분을 " +
      "제공합니다. 원 API에 업체명·사업자등록번호 검색 파라미터가 없어(넣어도 에러 없이 전체가 " +
      "돌아옵니다) 기간 전량을 받아 서버에서 거릅니다. 동작하는 원 API 필터는 지역(area·areaDetail)뿐입니다. " +
      "★ **0건을 '그런 업체가 없다'로 답하지 마세요.** 조회한 기간에 공시가 없었다는 뜻일 뿐입니다. " +
      "특정 회사를 찾는 것이 목적이면 기간을 넓혀 재조회하고, 답변에는 확인한 기간을 반드시 밝히세요. " +
      "★ **sDate~eDate 간격은 2년 이내로 잡으세요.** 원 API는 요청 하나에 20~40초가 걸려(행 수와 " +
      "거의 무관한 서버측 조회시간) 그보다 긴 기간은 응답 제한시간을 넘깁니다. 실측: 2년(약 25,000행)은 " +
      "정상, 4년은 타임아웃. 더 긴 이력이 필요하면 2년 단위로 나눠 여러 번 호출하고 ncrGsSeq로 합집합하세요. " +
      "★★ **여러 번 나눠 호출한 결과의 집계값을 더하지 마세요.** 구간 경계 공시가 양쪽에 들어와 " +
      "부풀려집니다 — 실측으로 2년치를 8분할해 합산했더니 건수 +0.42%, 과징금 총액 +3.22%(6.7억원) " +
      "과대 집계됐습니다. 부득이 합산했다면 '경계 중복이 포함된 근사치'임을 답변에 반드시 밝히세요. " +
      "잘림=true면 시간 제한으로 다 받지 못한 것이니 같은 원칙이 적용됩니다. " +
      "★ 같은 공시 1건이 보유 업종 수만큼 행으로 반복됩니다. 건수는 **조건일치_건수**(공시 고유)를 쓰고 " +
      "조건일치_행수를 건수로 보고하지 마세요. " +
      "행정처분·폐업 이력은 search_construction_sanctions를 쓰세요.",
    {
      sDate: z.string().describe("조회 시작일 YYYYMMDD (필수). 예: 20260101"),
      eDate: z.string().describe("조회 종료일 YYYYMMDD (필수). 예: 20260826"),
      kinds: z
        .array(z.enum(["reg", "renew", "trans", "union", "inheri"]))
        .optional()
        .describe("조회할 공시 종류. reg=신규등록 renew=등록기준사항신고 trans=양도 union=법인합병 inheri=상속 (기본 전부)"),
      area: z.string().optional().describe("등록 시도 (예: 서울, 경기, 부산, 전남광주). 원 API가 지원하는 필터"),
      areaDetail: z.string().optional().describe("등록 시군구 (예: 강남구, 성남시)"),
      companyName: z.string().optional().describe("업체명. 사업자등록번호를 자동 해석해 정확히 좁히고, 실패하면 업체명 부분검색으로 폴백합니다"),
      bizNo: z.string().optional().describe("사업자등록번호 10자리"),
      itemName: z.string().optional().describe("업종 부분검색 (예: 실내건축, 지반조성, 전기)"),
      limit: z.number().int().min(1).max(200).optional().describe("최대 반환 건수 (기본 30)"),
      maxPages: z.number().int().min(1).max(10).optional().describe(
        "오퍼레이션당 최대 페이지(10,000행 단위, 기본 3). 원 API가 한 요청당 20~40초라 이 값을 올리면 " +
          "응답 제한시간을 넘길 수 있습니다. 더 긴 기간이 필요하면 기간을 나눠 여러 번 호출하세요"
      ),
    },
    async (args) => {
      const result = await searchConstructionFirms(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_construction_sanctions",
    "국토교통부 키스콘(KISCON) **건설업체 행정처분·가처분·폐업 공시**를 조회합니다. 협력사·하도급사· " +
      "인수 후보의 법규 위반 이력을 확인하는 용도입니다. 처분명(영업정지·과징금·과태료·시정명령· " +
      "등록말소), **위반내용과 근거조문**(예: 건설산업기본법 제82조제2항제3호), 처분사유 전문, " +
      "**과징금·과태료 금액(원)**, 영업정지 기간, 가처분 여부, 취소일까지 나옵니다. " +
      "위반내용별 집계는 상위 몇 개가 아니라 **전량**을 돌려주므로 그대로 인용하면 됩니다(2년치 기준 80종 이상). " +
      "★ **기간 기반 조회입니다** — sDate·eDate(YYYYMMDD)가 필수입니다. 원 API에 업체명·사업자등록번호 " +
      "검색 파라미터가 없어 기간 전량을 받아 서버에서 거릅니다. " +
      "★ **0건을 '처분 이력이 없다'로 절대 답하지 마세요.** 조회한 기간에 공시가 없었다는 뜻일 뿐이며, " +
      "실사 목적이라면 기간을 수년 단위로 넓혀 재조회해야 합니다. " +
      "★ **sDate~eDate 간격은 2년 이내로 잡으세요.** 원 API는 요청 하나에 20~40초가 걸려(행 수와 " +
      "거의 무관한 서버측 조회시간) 그보다 긴 기간은 응답 제한시간을 넘깁니다. 실측: 2년(약 25,000행)은 " +
      "정상, 4년은 타임아웃. 더 긴 이력이 필요하면 2년 단위로 나눠 여러 번 호출하고 ncrGsSeq로 합집합하세요. " +
      "★★ **여러 번 나눠 호출한 결과의 집계값을 더하지 마세요.** 구간 경계 공시가 양쪽에 들어와 " +
      "부풀려집니다 — 실측으로 2년치를 8분할해 합산했더니 건수 +0.42%, 과징금 총액 +3.22%(6.7억원) " +
      "과대 집계됐습니다. 부득이 합산했다면 '경계 중복이 포함된 근사치'임을 답변에 반드시 밝히세요. " +
      "잘림=true면 시간 제한으로 다 받지 못한 것이니 같은 원칙이 적용됩니다. " +
      "★ 같은 처분 1건이 보유 업종 수만큼 행으로 반복됩니다. 건수는 **조건일치_건수**를 쓰고, " +
      "처분유형별·위반내용_상위·금액합계_원은 이미 고유 기준으로 집계된 값이니 그대로 인용하세요. " +
      "답변에는 확인한 기간을 반드시 밝히세요. 가처분(ncrPdStatus=Y)이 걸린 건은 처분 효력이 정지 중일 수 있습니다.",
    {
      sDate: z.string().describe("조회 시작일 YYYYMMDD (필수)"),
      eDate: z.string().describe("조회 종료일 YYYYMMDD (필수)"),
      kinds: z
        .array(z.enum(["admi", "admiPD", "cess"]))
        .optional()
        .describe("admi=행정처분 admiPD=행정처분 가처분 cess=폐업신고 (기본 전부)"),
      area: z.string().optional().describe("등록 시도 (예: 서울, 경기)"),
      areaDetail: z.string().optional().describe("등록 시군구"),
      companyName: z.string().optional().describe("업체명. 사업자등록번호를 자동 해석해 정확히 좁힙니다"),
      bizNo: z.string().optional().describe("사업자등록번호 10자리"),
      itemName: z.string().optional().describe("업종 부분검색"),
      limit: z.number().int().min(1).max(200).optional().describe("최대 반환 건수 (기본 30)"),
      maxPages: z.number().int().min(1).max(10).optional().describe(
        "오퍼레이션당 최대 페이지(10,000행 단위, 기본 3). 원 API가 한 요청당 20~40초라 이 값을 올리면 " +
          "응답 제한시간을 넘길 수 있습니다. 더 긴 기간이 필요하면 기간을 나눠 여러 번 호출하세요"
      ),
    },
    async (args) => {
      const result = await searchConstructionSanctions(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_construction_notice_stats",
    "국토교통부 키스콘(KISCON) **건설공사대장 통보 통계**를 조회합니다. 일자 × 지역 × 발주구분" +
      "(공공/민간법인/민간개인) × 도급구분(원도급/하도급)으로 집계된 **통보 건수와 금액**을 서버가 " +
      "결합해 돌려줍니다(원 API는 건수·금액이 별도 오퍼레이션). 건설시장의 공공/민간 비중, 하도급 " +
      "비중, 지역별 물량 추이를 보는 데 씁니다. groupBy로 발주구분·지역·도급구분·일자 중 집계 축을 " +
      "고릅니다. " +
      "★ 원 응답에는 지역 '전체'·발주구분 '전체' 합계 행이 실제 항목과 같은 배열에 섞여 있어 그대로 " +
      "더하면 중복 계상됩니다 — 서버가 제외하고 집계하므로 **반환된 집계값을 다시 합산하지 마세요.** " +
      "★ **금액 단위는 억원으로 판단됩니다** — 원 명세에는 표기가 없으나 통보 대상이 도급금액 1억원 " +
      "이상(건설산업기본법 시행령 제26조제1항)인데 실측 건당 평균이 4.4로 나와 다른 단위로는 " +
      "성립하지 않습니다. 명세로 확인된 값은 아니므로 대외 인용 시 근거를 함께 밝히세요. " +
      "★ 지역·발주구분·도급구분은 **원 API가 서버에서 걸러 주는 진짜 필터**입니다(시도명·구분명을 " +
      "그대로 넣으면 서버가 코드로 바꿔 전달합니다). 조회 범위를 좁힐수록 응답이 가볍습니다. " +
      "★ 이 통계는 **2020-07-15부터** 제공됩니다 — 건설업체정보(2003-01-01~)와 시작일이 다릅니다.",
    {
      sDate: z.string().describe("조회 시작일 YYYYMMDD (필수). 이 통계는 2020-07-15부터 제공됩니다"),
      eDate: z.string().describe("조회 종료일 YYYYMMDD (필수). 기간이 길수록 원본 행이 급격히 늘어납니다"),
      area: z
        .string()
        .optional()
        .describe("지역 필터. 시도명(서울·부산·경기 등) 또는 코드. 원 API가 서버에서 걸러 줍니다"),
      balju: z
        .string()
        .optional()
        .describe("발주구분 필터: 공공 / 민간(법인) / 민간(개인). 원 API가 서버에서 걸러 줍니다"),
      dogub: z
        .string()
        .optional()
        .describe("도급구분 필터: 원도급 / 하도급. 원 API가 서버에서 걸러 줍니다"),
      groupBy: z
        .enum(["balju", "area", "dogub", "date"])
        .optional()
        .describe("집계 축: balju=발주구분(기본) area=지역 dogub=도급구분 date=일자"),
      maxPages: z.number().int().min(1).max(20).optional().describe("오퍼레이션당 최대 페이지(5,000행 단위, 기본 10)"),
    },
    async (args) => {
      const result = await getConstructionNoticeStats(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 국토교통부 건설CALS (calspia.go.kr) ──────────────────────────────────
  server.tool(
    "search_cals_construction",
    "국토교통부 **건설CALS 공사정보**를 검색합니다. 공사명·현장번호·발주기관·사업분야·노선/하천·" +
      "행정구역·착공일·준공(예정)일이 나옵니다. 여기서 얻은 **현장번호(sptNo)** 를 " +
      "get_cals_construction_detail에 넣어 상세로 들어갑니다. " +
      "★ **데이터 범위가 좁습니다** — 국토교통부 5개 지방국토관리청(서울·원주·대전·익산·부산) " +
      "발주 공사만 담겨 있습니다(실측 1,362건). 민간 건축공사, 지자체·LH·공사·공단 발주분은 " +
      "**여기에 아예 없습니다.** '전국 건설현장 현황'으로 확대해석하지 마세요. " +
      "★ status는 전체(기본)/진행/준공이며 **모집단이 서로 다릅니다.** 전체 목록은 1,362건" +
      "(진행 141 + 완료 1,221)인데 진행 상세검색은 140건, 준공 상세검색은 254건뿐입니다 — " +
      "상세검색 2종은 전체의 부분집합이라 건수를 총수로 인용하면 틀립니다. 폭넓게 보려면 " +
      "status=전체에 progress로 진행/완료를 거르세요(원 API의 준공여부 파라미터가 무시되므로 서버가 직접 거릅니다). " +
      "★ 상세검색(진행/준공)에서만 사업분야·행정구역·착공일·준공일 필터가 동작합니다.",
    {
      status: z.enum(["전체", "진행", "준공"]).optional().describe("조회할 오퍼레이션. 기본 전체"),
      progress: z.enum(["진행", "완료"]).optional().describe("status=전체일 때만 적용되는 진행/완료 필터"),
      cwkNm: z.string().optional().describe("공사명 부분검색"),
      orcd: z.string().optional().describe("발주기관 코드 (코드집 기준)"),
      bzarCd: z.string().optional().describe("사업분야 코드. status=진행/준공에서만 동작"),
      pdznNm: z.string().optional().describe("행정구역명. status=진행/준공에서만 동작"),
      stwrDt: z.string().optional().describe("착공일 조건. status=진행/준공에서만 동작"),
      ccwDt: z.string().optional().describe("준공일 조건. status=진행/준공에서만 동작"),
      limit: z.number().int().min(1).max(200).optional().describe("최대 반환 건수 (기본 30)"),
      maxPages: z.number().int().min(1).max(5).optional().describe("최대 페이지(1,000행 단위, 기본 3)"),
    },
    async (args) => {
      const result = await searchCalsConstruction(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_cals_construction_detail",
    "건설CALS에서 **특정 현장(sptNo)의 상세정보**를 섹션별로 한 번에 가져옵니다. " +
      "연도별계약·집행금액·기성보고입찰·설계변경·설계변경내역·기성보고·월간공정과 " +
      "공사중인 시설물 7종(교량·터널·절개사면·통로박스·옹벽·수문·제방)을 고를 수 있습니다. " +
      "★ sptNo는 search_cals_construction으로 먼저 확보하세요. " +
      "★ 설계변경·설계변경내역·기성보고는 **차수(sptTo)** 가, 월간공정은 차수와 **보고연월(rprtYm, YYYYMM)** 이 " +
      "추가로 필요합니다. rprtYm 없이 월간공정을 요청하면 그 섹션만 안내와 함께 건너뜁니다. " +
      "★ 섹션이 0건이어도 오류가 아닙니다 — 그 현장에 해당 자료가 등록되지 않았다는 뜻입니다.",
    {
      sptNo: z.string().describe("현장번호 (필수). 예: C2023021"),
      sections: z
        .array(z.string())
        .optional()
        .describe(
          "가져올 섹션. 생략 시 연도별계약·설계변경·교량·터널. 사용 가능: " + DETAIL_SECTION_NAMES.join(", ")
        ),
      sptTo: z.string().optional().describe("차수. 설계변경·기성보고·월간공정에 필요 (기본 1)"),
      rprtYm: z.string().optional().describe("보고연월 YYYYMM. 월간공정 섹션에 필요"),
      limitPerSection: z.number().int().min(1).max(100).optional().describe("섹션당 최대 행수 (기본 20)"),
    },
    async (args) => {
      const result = await getCalsConstructionDetail(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_cals_contractor",
    "건설CALS **국토관리청 참여업체와 그 업체의 참여공사 이력**을 조회합니다. 업체명 또는 " +
      "사업자등록번호로 찾으면 대표자·대표공사와 함께 **참여공사 목록(공사명·발주기관·사업분야·" +
      "참여단계(시공/설계/감리)·지분율·도급액·준공여부·공사기간)** 이 나옵니다. 협력사·경쟁사·인수후보의 " +
      "공공공사 수행이력을 확인하는 용도입니다. " +
      "★ **명부가 좁습니다** — 국토교통부 5개 지방국토관리청 발주 공사의 참여업체 약 995개만 담겨 " +
      "있습니다. **0건을 '그런 업체가 없다'로 절대 답하지 마세요.** 민간공사나 지자체 공사만 수행한 " +
      "업체는 여기에 없는 것이 정상입니다. 그 경우 키스콘(search_construction_firms)으로 교차 확인하세요. " +
      "★ 참여이력은 1996년 준공 건까지 거슬러 올라갑니다 — 오래된 실적이 섞이므로 공사기간을 함께 보세요. " +
      "★ 원 API에 업체 검색 파라미터가 없어 명부 전량을 받아 서버에서 거릅니다((주)·주식회사 표기 차이는 무시합니다).",
    {
      companyName: z.string().optional().describe("업체명 부분검색. (주)·주식회사 표기 차이는 무시"),
      bizNo: z.string().optional().describe("사업자등록번호 10자리. 있으면 이쪽이 우선"),
      limit: z.number().int().min(1).max(50).optional().describe("최대 업체 수 (기본 30)"),
    },
    async (args) => {
      const result = await searchCalsContractor(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_cals_quality_tests",
    "건설CALS **건설자재 품질검사 등록정보**로 전국 건설현장을 추적합니다. 이 서버의 건설 도구 중 " +
      "**유일하게 전국을 덮는 현장 데이터**입니다(공사정보·참여업체는 국토관리청 한정). " +
      "공사명·**시공사명**·발주처·착공일·**준공예정일**이 함께 나와, 특정 건설사의 현장 목록을 뽑아 " +
      "준공예정일 기준으로 공정 진입 시점을 역산하는 데 씁니다. 서버가 현장 단위로 접어서 돌려줍니다" +
      "(같은 현장이 시험 건마다 반복되므로 행 수 ≠ 현장 수). " +
      "★★ **이 데이터는 " + QUALITY_DATA_CUTOFF + "에서 멈춰 있습니다.** 2025년·2026년 등록분이 전 시공사에 걸쳐 " +
      "0건입니다(연도별 자재 품질검사 실측: 2022년 237,629 / 2023년 245,067 / 2024년 142,387 / 2025년 0 / 2026년 0). " +
      "**신규 현장을 찾는 선행지표로 쓸 수 없습니다.** 고객사별 현장 이력·경쟁구도 분석 같은 후행 용도이며, " +
      "'현재 진행 중인 현장'이라고 답하면 틀립니다. 최신 현장이 필요하면 다른 소스를 쓰세요. " +
      "★ 경로가 둘입니다. **contractorName(시공사명)** 을 주면 성적서 등록 목록을 시공사 기준으로 조회하고" +
      "(대형 건설사도 잡힙니다 — 실측 2020~2026 누적: 포스코이앤씨 32,643 / 대우건설 31,256 / 현대건설 28,115 / " +
      "GS건설 17,141 / 삼성물산 11,765건), **year(연도)** 만 주면 자재 품질검사 등록정보를 조회합니다" +
      "(이쪽에는 시공사 필터가 없어 공사명·자재명으로 좁혀야 합니다). " +
      "★ 잘림=true면 수집한 행 안에서만 집계한 값입니다 — 고유현장수를 그 시공사의 전체 현장 수로 인용하지 마세요.",
    {
      contractorName: z.string().optional().describe("시공사명. 이 값을 주면 성적서 등록 목록 경로로 조회"),
      sDate: z.string().optional().describe("성적서 발급일 시작 YYYYMMDD (기본 20200101). contractorName 경로 전용"),
      eDate: z.string().optional().describe("성적서 발급일 종료 YYYYMMDD (기본 20241231). contractorName 경로 전용"),
      year: z.string().optional().describe("연도 YYYY. contractorName 없이 쓰면 자재 품질검사 등록정보 경로"),
      cwkNm: z.string().optional().describe("공사명 부분검색. year 경로 전용"),
      materialName: z.string().optional().describe("자재/검사기관명 부분검색"),
      permitNo: z.string().optional().describe("품질검사 허가번호. year 경로 전용"),
      limit: z.number().int().min(1).max(200).optional().describe("최대 현장 수 (기본 30)"),
      maxPages: z.number().int().min(1).max(5).optional().describe("최대 페이지(1,000행 단위, 기본 3)"),
    },
    async (args) => {
      const result = await searchCalsQualityTests(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_cals_project_evaluation",
    "건설CALS **건설공사 사후평가**와 **설계VE(설계경제성 검토)** 를 조회합니다. 둘 다 **전국 공공발주기관** " +
      "대상이라 건설시장 구조와 발주처 동향을 보는 데 씁니다. " +
      "사후평가는 공사발주금액·준공일과 함께 **계획 대비 실제 수요, 공사비 증감률, 공기 증감률**을 주므로 " +
      "발주처별 사업 집행 정확도를 비교할 수 있습니다(실측 175개 발주기관: 국가철도공단·한국전력공사·" +
      "지자체 등, 유형은 도로·철도·항만·공항·수자원·기타). " +
      "설계VE는 총공사비·공사위치·VE단계·공사구분(토목/건축)을 주며 실측 184개 발주청입니다" +
      "(한국토지주택공사·국가철도공단·한국수자원공사 순). " +
      "★ 사후평가의 기간은 **YYYYMM(월 단위)** 입니다 — YYYYMMDD를 주면 파라미터 오류가 아니라 DB 오류로 " +
      "떨어지므로 서버가 앞 6자리로 잘라 쓰고 그 사실을 응답에 밝힙니다. " +
      "★ 사후평가는 **총사업비가 일정 규모 이상인 공사만** 대상이라 소규모 공사는 없습니다 — " +
      "0건을 '그런 사업이 없었다'로 읽지 마세요. " +
      "★ 설계VE의 총공사비 단위는 원 명세에 표기가 없어 확정하지 못했습니다(백만원으로 보임). 대외 인용 시 원 자료로 확인하세요.",
    {
      kind: z.enum(["사후평가", "설계VE"]).optional().describe("조회 대상 (기본 사후평가)"),
      sYm: z.string().optional().describe("사후평가 준공 시작년월 YYYYMM (기본 201001)"),
      eYm: z.string().optional().describe("사후평가 준공 종료년월 YYYYMM (기본 202612)"),
      orderOrgName: z.string().optional().describe("발주기관/발주청명 부분검색"),
      projectName: z.string().optional().describe("사업명 부분검색"),
      contractorName: z.string().optional().describe("시공사명 (사후평가 전용)"),
      bizTypeCd: z.string().optional().describe("사업유형 코드 (사후평가 전용)"),
      constClass: z.string().optional().describe("공사구분 (설계VE 전용)"),
      minAmt: z.string().optional().describe("최소 공사비 (설계VE 전용)"),
      maxAmt: z.string().optional().describe("최대 공사비 (설계VE 전용)"),
      limit: z.number().int().min(1).max(200).optional().describe("최대 반환 건수 (기본 30)"),
      maxPages: z.number().int().min(1).max(5).optional().describe("최대 페이지(1,000행 단위, 기본 3)"),
    },
    async (args) => {
      const result = await searchCalsProjectEvaluation(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_cals_road_occupancy",
    "건설CALS **도로점용허가** 내역을 조회합니다. 허가기관·신청인·허가일·허가사유·허가번호가 나옵니다. " +
      "통신사·전력회사 등이 국도에 설비를 놓을 때 받는 허가라, 인프라 사업자의 지역별 공사 움직임을 " +
      "읽는 데 씁니다(실측 신청인 상위: LG유플러스·KT·SK텔레콤·SK브로드밴드·한전 및 지자체). " +
      "★ sDate·eDate(YYYYMMDD)가 필수인 **기간 조회**입니다. 0건은 그 기간에 허가가 없었다는 뜻일 뿐 " +
      "'그 회사가 점용허가를 받은 적 없다'가 아닙니다. " +
      "★ 원 API의 신청인·허가기관·허가번호 필터는 **조용히 무시되므로**(실측: 어떤 필터를 줘도 건수가 동일) " +
      "서버가 기간 전량을 받아 직접 거릅니다. 그래서 **잘림=true면 해당 신청인의 건이 더 있을 수 있습니다** — " +
      "이 경우 기간을 좁혀 다시 조회하세요. " +
      "★ 신청인 표기가 제각각입니다('(주)케이티', '주식회사 케이티', '(주)케이티 진천지점' 등). 서버가 " +
      "(주)·주식회사 표기를 무시하고 부분일치로 묶지만, 지사·지점명이 붙은 건은 별도 항목으로 보입니다. " +
      "★ 지방국토관리청이 관리하는 국도 등이 대상이며 지자체 관리 도로는 포함되지 않습니다.",
    {
      sDate: z.string().describe("허가일 시작 YYYYMMDD (필수)"),
      eDate: z.string().describe("허가일 종료 YYYYMMDD (필수)"),
      applicantName: z.string().optional().describe("신청인 부분검색. 서버가 직접 거릅니다"),
      orgName: z.string().optional().describe("허가기관 부분검색. 서버가 직접 거릅니다"),
      permitNo: z.string().optional().describe("허가번호 부분검색. 서버가 직접 거릅니다"),
      limit: z.number().int().min(1).max(200).optional().describe("최대 반환 건수 (기본 30)"),
      maxPages: z.number().int().min(1).max(5).optional().describe("최대 페이지(1,000행 단위, 기본 3)"),
    },
    async (args) => {
      const result = await searchCalsRoadOccupancy(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );


  // ── 국토교통부 건축HUB 건축인허가 (세움터) ───────────────────────────────
  server.tool(
    "scan_arch_permits",
    "국토교통부 **건축HUB 건축인허가**(세움터)를 지역 단위로 스캔해 신규 허가·착공 건을 찾습니다. " +
      "**민간 건축공사를 덮는 유일한 도구**입니다 — 건설CALS는 국토관리청 토목, 키스콘은 건설업체 " +
      "등록·처분이라 민간 건축현장이 없습니다. " +
      "대지위치·건물명·건축구분(신축/증축/대수선/용도변경)·주용도·연면적·세대수와 함께 " +
      "**건축허가일·착공예정일·실제착공일·사용승인일**이 나오므로, 후속 공정 진입 시점을 역산하는 데 씁니다. " +
      "★ **데이터가 최신입니다** — 실측 지연 " + ARCHHUB_DATA_LAG + ". 건설CALS 품질검사(2024-08-30 정지)와 달리 " +
      "선행지표로 쓸 수 있습니다. " +
      "★ **원 API는 법정동 단위 조회입니다.** 시군구만 주면 에러 없이 빈 결과가 옵니다(resultCode는 00). " +
      "region에 시군구명('강남구', '성남시 분당구')을 주면 서버가 법정동 목록을 해석해 순회합니다. " +
      "실측 강남구는 법정동 14개이고 **전국은 " + TOTAL_BJDONG.toLocaleString() + "개**입니다. " +
      "★★ **이 API는 페이지당 100행이 상한입니다** — numOfRows에 1,000을 줘도 에러 없이 100으로 깎여 돌아옵니다. 통계를 낼 목적이면 반드시 끝까지 페이징해서 전량을 받으세요(응답의 잘림 여부를 확인할 것). 잘린 100건은 무작위 표본이 아니라 원 API가 첫 페이지에 주는 순서대로의 100건이고 그 정렬 기준은 명세에 없으므로, 잘린 표본으로 중앙값·사분위를 내면 무엇의 통계인지 말할 수 없습니다. " + "★★ **일일 트래픽 10,000건입니다.** maxDongs로 순회 수를 조절하세요(기본 20). 전국 전수 스캔은 하루에 불가능하니 " +
      "관심 시군구를 좁혀 쓰세요. 응답의 지역해석.잘림=true면 그 시군구에 더 많은 법정동이 있다는 뜻입니다. " +
      "★★ **since·until은 건축허가일이 아니라 데이터 생성일(crtnDay) 기준입니다.** 실측에서 2026년 구간으로 " +
      "조회했더니 허가일 2007년 건이 섞여 나왔습니다. 허가일로 좁히려면 permitFrom·permitTo를 쓰세요.",
    {
      region: z.string().optional().describe("시군구명. 예: 강남구, 성남시 분당구. 서버가 법정동으로 해석해 순회"),
      sigunguCd: z.string().optional().describe("시군구코드 5자리. bjdongCds와 함께 쓸 때만"),
      bjdongCds: z.array(z.string()).optional().describe("법정동코드 5자리 배열. sigunguCd와 함께"),
      since: z.string().optional().describe("데이터 생성일 시작 YYYYMMDD (허가일이 아님)"),
      until: z.string().optional().describe("데이터 생성일 종료 YYYYMMDD (허가일이 아님)"),
      permitFrom: z.string().optional().describe("건축허가일 시작 YYYYMMDD. 서버가 직접 거릅니다"),
      permitTo: z.string().optional().describe("건축허가일 종료 YYYYMMDD. 서버가 직접 거릅니다"),
      archGb: z.string().optional().describe("건축구분 부분검색: 신축 / 증축 / 대수선 / 용도변경"),
      mainPurps: z.string().optional().describe("주용도 부분검색: 공동주택 / 업무시설 / 숙박시설 / 제2종근린생활시설 등"),
      minTotArea: z.number().optional().describe("최소 연면적(㎡). 규모 있는 현장만 볼 때"),
      stage: z.enum(["허가", "착공", "사용승인"]).optional().describe("허가=허가났고 미착공 / 착공=착공했고 미승인 / 사용승인=승인완료"),
      maxDongs: z.number().int().min(1).max(60).optional().describe("순회할 법정동 수 (기본 20). 트래픽과 응답시간에 직결"),
      limit: z.number().int().min(1).max(200).optional().describe("최대 반환 건수 (기본 50)"),
    },
    async (args) => {
      const result = await scanArchPermits(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_arch_permits",
    "건축HUB 건축인허가를 **특정 법정동·지번**으로 조회합니다. 지역 전체가 아니라 아는 주소 한 곳을 " +
      "확인할 때 씁니다(지역 단위 발굴은 scan_arch_permits). 반환 필드는 scan_arch_permits와 같습니다. " +
      "★ sigunguCd(5자리)와 bjdongCd(5자리)가 **둘 다** 필요합니다. 시군구만 주면 원 API가 에러 없이 " +
      "빈 결과를 돌려줍니다. 법정동코드 10자리는 앞 5자리가 시군구, 뒤 5자리가 법정동입니다" +
      "(예: 1168010300 = 11680 강남구 + 10300 개포동). 코드를 모르면 scan_arch_permits에 region으로 시군구명을 주면 됩니다. " +
      "★ bun(번)·ji(지)를 주면 그 지번만 봅니다. 생략하면 그 법정동 전체입니다. " +
      "★ since·until은 데이터 생성일 기준이라 허가일과 다릅니다 — 허가일은 permitFrom·permitTo를 쓰세요. " +
      "★ 한 지번에 인허가 건이 여러 개 있는 것이 정상입니다(신축 후 용도변경, 증축 등). " +
      "관리번호(mgmPmsrgstPk)가 건별 식별자이며, 22자리라 숫자로 다루면 정밀도가 깨지므로 문자열로 돌려줍니다.",
    {
      sigunguCd: z.string().describe("시군구코드 5자리 (필수)"),
      bjdongCd: z.string().describe("법정동코드 5자리 (필수)"),
      bun: z.string().optional().describe("번. 4자리로 자동 zero-padding"),
      ji: z.string().optional().describe("지. 4자리로 자동 zero-padding"),
      platGbCd: z.string().optional().describe("대지구분 0:대지 1:산 2:블록"),
      since: z.string().optional().describe("데이터 생성일 시작 YYYYMMDD"),
      until: z.string().optional().describe("데이터 생성일 종료 YYYYMMDD"),
      permitFrom: z.string().optional().describe("건축허가일 시작 YYYYMMDD"),
      permitTo: z.string().optional().describe("건축허가일 종료 YYYYMMDD"),
      archGb: z.string().optional().describe("건축구분 부분검색"),
      mainPurps: z.string().optional().describe("주용도 부분검색"),
      minTotArea: z.number().optional().describe("최소 연면적(㎡)"),
      stage: z.enum(["허가", "착공", "사용승인"]).optional().describe("진행 단계 필터"),
      limit: z.number().int().min(1).max(200).optional().describe("최대 반환 건수 (기본 30)"),
      maxPages: z.number().int().min(1).max(200).optional().describe("최대 페이지. 이 API는 **페이지당 100행이 상한**이라(numOfRows를 크게 줘도 100으로 깎임) 전량이 필요하면 넉넉히 주세요. 기본 20"),
    },
    async (args) => {
      const result = await searchArchPermits(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_arch_permit_detail",
    "건축HUB 건축인허가의 **상세정보를 섹션별로** 가져옵니다. 동별개요(주용도·구조·호수·세대수)· " +
      "층별개요·호별개요·전유공용면적·호별전유공용면적·주차장·부설주차장·주택유형·지역지구구역· " +
      "도로명대장·대지위치 중에서 고릅니다. 설비 물량을 가늠할 때 동별개요와 주택유형이 특히 유용합니다. " +
      "★ **원 API는 관리번호가 아니라 주소로 조회합니다.** scan_arch_permits / search_arch_permits 결과의 " +
      "시군구코드·법정동코드·번·지를 그대로 넘기세요. 한 지번에 여러 인허가 건이 섞여 나오므로 특정 건만 " +
      "보려면 mgmPmsrgstPk를 함께 주세요 — 서버가 받은 뒤 거릅니다(이 경우 건수는 필터 후 값입니다). " +
      "★ 섹션이 0건이어도 오류가 아닙니다. 그 건축물에 해당 자료가 없다는 뜻입니다.",
    {
      sigunguCd: z.string().describe("시군구코드 5자리 (필수)"),
      bjdongCd: z.string().describe("법정동코드 5자리 (필수)"),
      bun: z.string().optional().describe("번"),
      ji: z.string().optional().describe("지"),
      platGbCd: z.string().optional().describe("대지구분"),
      sections: z
        .array(z.string())
        .optional()
        .describe("가져올 섹션. 생략 시 동별개요·층별개요·주차장·주택유형. 사용 가능: " + DETAIL_SECTIONS.join(", ")),
      mgmPmsrgstPk: z.string().optional().describe("관리번호. 주면 그 건만 남깁니다(문자열로 주세요)"),
      limitPerSection: z.number().int().min(1).max(100).optional().describe("섹션당 최대 행수 (기본 20)"),
    },
    async (args) => {
      const result = await getArchPermitDetail(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_arch_aux_registers",
    "건축HUB의 **철거멸실·대수선·가설건축물·공작물·오수정화시설** 대장을 조회합니다. " +
      "특히 **철거멸실은 재건축·재개발의 선행지표**입니다 — 멸실 신고 뒤에 신축 인허가가 따라오므로, " +
      "scan_arch_permits보다 한 단계 앞선 시점에 지역의 개발 움직임을 잡을 수 있습니다. " +
      "철거멸실은 철거/멸실 구분, 착수·완료일, 연면적, 건축물 수, 주용도, 석면 함유 여부를 제공합니다. " +
      "★ 이 API도 **법정동 단위 조회**입니다. region에 시군구명을 주면 서버가 법정동을 해석해 순회하고, " +
      "maxDongs로 순회 수를 조절합니다(기본 10). 일일 트래픽 10,000건 안에서 쓰세요. " +
      "★ 철거멸실 대장의 관리번호는 아직 **구 PK 형식**(시군구코드-일련번호, 예: 11680-100062686)으로 " +
      "내려옵니다. 기본개요의 22자리 신규 PK와 형식이 달라 그대로는 매칭되지 않습니다 — " +
      "국토교통부 PK 전환 규칙(통합분류코드 4자리 + 대장구분 + 일련번호)을 거쳐야 연결됩니다. " +
      "★ since·until은 데이터 생성일 기준입니다.",
    {
      region: z.string().optional().describe("시군구명. 서버가 법정동으로 해석해 순회"),
      sigunguCd: z.string().optional().describe("시군구코드 5자리. bjdongCd와 함께"),
      bjdongCd: z.string().optional().describe("법정동코드 5자리"),
      bun: z.string().optional().describe("번"),
      ji: z.string().optional().describe("지"),
      kinds: z
        .array(z.enum(["철거멸실", "대수선", "가설건축물", "공작물", "오수정화시설"]))
        .optional()
        .describe("조회할 대장 종류 (기본 철거멸실)"),
      since: z.string().optional().describe("데이터 생성일 시작 YYYYMMDD"),
      until: z.string().optional().describe("데이터 생성일 종료 YYYYMMDD"),
      maxDongs: z.number().int().min(1).max(40).optional().describe("순회할 법정동 수 (기본 10)"),
      limitPerKind: z.number().int().min(1).max(100).optional().describe("종류별 최대 행수 (기본 20)"),
    },
    async (args) => {
      const result = await searchArchAuxRegisters(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  registerHousingTools(server, z);

  return server;
}
