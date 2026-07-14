/**
 * Mock data for browser dev (VITE_API_MODE=mock). Cities mirror draft_seed.sql
 * (30 cities, region_slug groups). Vacancies are synthetic but realistic and
 * span every work_type / gender / city cluster so the UI can be reviewed by eye.
 */
import type {
  City,
  Gender,
  Me,
  SalaryPeriod,
  VacancyContact,
  VacancyView,
  WorkType,
} from '../../types/api';

export const CITIES: City[] = [
  { slug: 'seoul', name: { ru: 'Сеул', ko: '서울', en: 'Seoul' }, region_slug: 'seoul' },
  { slug: 'busan', name: { ru: 'Пусан', ko: '부산', en: 'Busan' }, region_slug: 'busan' },
  { slug: 'incheon', name: { ru: 'Инчхон', ko: '인천', en: 'Incheon' }, region_slug: 'incheon' },
  { slug: 'daegu', name: { ru: 'Тэгу', ko: '대구', en: 'Daegu' }, region_slug: 'daegu' },
  { slug: 'daejeon', name: { ru: 'Тэджон', ko: '대전', en: 'Daejeon' }, region_slug: 'daejeon' },
  { slug: 'gwangju', name: { ru: 'Кванджу', ko: '광주', en: 'Gwangju' }, region_slug: 'gwangju' },
  { slug: 'ulsan', name: { ru: 'Ульсан', ko: '울산', en: 'Ulsan' }, region_slug: 'ulsan' },
  { slug: 'suwon', name: { ru: 'Сувон', ko: '수원', en: 'Suwon' }, region_slug: 'gyeonggi' },
  { slug: 'ansan', name: { ru: 'Ансан', ko: '안산', en: 'Ansan' }, region_slug: 'gyeonggi' },
  { slug: 'hwaseong', name: { ru: 'Хвасон', ko: '화성', en: 'Hwaseong' }, region_slug: 'gyeonggi' },
  { slug: 'pyeongtaek', name: { ru: 'Пхёнтхэк', ko: '평택', en: 'Pyeongtaek' }, region_slug: 'gyeonggi' },
  { slug: 'bucheon', name: { ru: 'Пучхон', ko: '부천', en: 'Bucheon' }, region_slug: 'gyeonggi' },
  { slug: 'seongnam', name: { ru: 'Соннам', ko: '성남', en: 'Seongnam' }, region_slug: 'gyeonggi' },
  { slug: 'goyang', name: { ru: 'Коян', ko: '고양', en: 'Goyang' }, region_slug: 'gyeonggi' },
  { slug: 'yongin', name: { ru: 'Ёнин', ko: '용인', en: 'Yongin' }, region_slug: 'gyeonggi' },
  { slug: 'gimpo', name: { ru: 'Кимпхо', ko: '김포', en: 'Gimpo' }, region_slug: 'gyeonggi' },
  { slug: 'paju', name: { ru: 'Паджу', ko: '파주', en: 'Paju' }, region_slug: 'gyeonggi' },
  { slug: 'namyangju', name: { ru: 'Намянджу', ko: '남양주', en: 'Namyangju' }, region_slug: 'gyeonggi' },
  { slug: 'uijeongbu', name: { ru: 'Ыйджонбу', ko: '의정부', en: 'Uijeongbu' }, region_slug: 'gyeonggi' },
  { slug: 'gwangmyeong', name: { ru: 'Кванмён', ko: '광명', en: 'Gwangmyeong' }, region_slug: 'gyeonggi' },
  { slug: 'gimhae', name: { ru: 'Кимхэ', ko: '김해', en: 'Gimhae' }, region_slug: 'gyeongnam' },
  { slug: 'changwon', name: { ru: 'Чханвон', ko: '창원', en: 'Changwon' }, region_slug: 'gyeongnam' },
  { slug: 'cheonan', name: { ru: 'Чхонан', ko: '천안', en: 'Cheonan' }, region_slug: 'chungnam' },
  { slug: 'asan', name: { ru: 'Асан', ko: '아산', en: 'Asan' }, region_slug: 'chungnam' },
  { slug: 'cheongju', name: { ru: 'Чхонджу', ko: '청주', en: 'Cheongju' }, region_slug: 'chungbuk' },
  { slug: 'jeonju', name: { ru: 'Чонджу', ko: '전주', en: 'Jeonju' }, region_slug: 'jeonbuk' },
  { slug: 'pohang', name: { ru: 'Пхохан', ko: '포항', en: 'Pohang' }, region_slug: 'gyeongbuk' },
  { slug: 'gumi', name: { ru: 'Куми', ko: '구미', en: 'Gumi' }, region_slug: 'gyeongbuk' },
  { slug: 'wonju', name: { ru: 'Вонджу', ko: '원주', en: 'Wonju' }, region_slug: 'gangwon' },
  { slug: 'jeju', name: { ru: 'Чеджу', ko: '제주', en: 'Jeju' }, region_slug: 'jeju' },
];

interface RawVacancy {
  id: string;
  city: string;
  work_type: WorkType;
  gender: Gender;
  salary_text: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_period: SalaryPeriod | null;
  employer: string | null;
  description: string;
  contact: VacancyContact | null;
  minsAgo: number;
}

const RAW: RawVacancy[] = [
  { id: 'v01', city: 'ansan', work_type: 'factory', gender: 'male', salary_text: '12,000₩/час, есть подработка', salary_min: 12000, salary_max: null, salary_period: 'hour', employer: '부성 산업', description: 'Сборка автозапчастей на заводе в Ансане. График 5/2, возможны сверхурочные. Жильё предоставляется, спецодежда бесплатно.', contact: { kind: 'phone', value: '010-2345-6789' }, minsAgo: 8 },
  { id: 'v02', city: 'hwaseong', work_type: 'factory', gender: 'any', salary_text: '월 2,800,000₩', salary_min: 2800000, salary_max: null, salary_period: 'month', employer: '화성 정밀', description: 'Оператор станка ЧПУ, обучение на месте. Оформление по визе, помощь с документами.', contact: { kind: 'kakao', value: 'hwaseong_job' }, minsAgo: 25 },
  { id: 'v03', city: 'pyeongtaek', work_type: 'construction', gender: 'male', salary_text: '일당 150,000₩', salary_min: 150000, salary_max: null, salary_period: 'day', employer: null, description: 'Разнорабочие на стройку в Пхёнтхэке. Оплата ежедневная, наличными. Нужны крепкие руки, опыт приветствуется.', contact: { kind: 'phone', value: '010-8811-2244' }, minsAgo: 42 },
  { id: 'v04', city: 'jeonju', work_type: 'agriculture', gender: 'any', salary_text: '시급 11,000₩', salary_min: 11000, salary_max: null, salary_period: 'hour', employer: '전주 농장', description: 'Работа в теплице: сбор клубники и упаковка. Можно парами. Проживание рядом с фермой.', contact: { kind: 'phone', value: '010-5566-7788' }, minsAgo: 55 },
  { id: 'v05', city: 'busan', work_type: 'fishery', gender: 'male', salary_text: '월 3,200,000₩ + питание', salary_min: 3200000, salary_max: null, salary_period: 'month', employer: '부산 수산', description: 'Рыбзавод в Пусане: разделка и заморозка. Тёплый цех, стабильная зарплата, аванс каждые 2 недели.', contact: { kind: 'telegram', value: '@busan_fish_hr' }, minsAgo: 70 },
  { id: 'v06', city: 'seoul', work_type: 'restaurant', gender: 'female', salary_text: '시급 12,500₩', salary_min: 12500, salary_max: null, salary_period: 'hour', employer: '명동 식당', description: 'Кухня и мойка в ресторане в центре Сеула (Мёндон). График сменный, питание бесплатно.', contact: { kind: 'phone', value: '010-9090-1212' }, minsAgo: 95 },
  { id: 'v07', city: 'incheon', work_type: 'logistics', gender: 'any', salary_text: '시급 11,500₩, дневные и ночные смены', salary_min: 11500, salary_max: null, salary_period: 'hour', employer: '인천 물류센터', description: 'Склад маркетплейса в Инчхоне: сортировка и упаковка посылок. Автобус от метро, ночные смены дороже.', contact: { kind: 'kakao', value: 'incheon_logi' }, minsAgo: 130 },
  { id: 'v08', city: 'suwon', work_type: 'cleaning', gender: 'female', salary_text: '일 100,000₩', salary_min: 100000, salary_max: null, salary_period: 'day', employer: null, description: 'Уборка квартир и офисов в Сувоне. Утренние смены, удобно для женщин. Оплата понедельно.', contact: { kind: 'phone', value: '010-3434-5656' }, minsAgo: 160 },
  { id: 'v09', city: 'daegu', work_type: 'food', gender: 'any', salary_text: '월 2,600,000₩', salary_min: 2600000, salary_max: null, salary_period: 'month', employer: '대구 식품', description: 'Пищевое производство (кимчи, соусы) в Тэгу. Цех с кондиционером, спецодежда, оформление.', contact: null, minsAgo: 190 },
  { id: 'v10', city: 'changwon', work_type: 'factory', gender: 'male', salary_text: '시급 12,000₩', salary_min: 12000, salary_max: null, salary_period: 'hour', employer: '창원 기계', description: 'Завод металлоконструкций в Чханвоне. Сварка/сборка, обучение. Общежитие в 50 м от завода.', contact: { kind: 'phone', value: '010-7788-9900' }, minsAgo: 230 },
  { id: 'v11', city: 'cheonan', work_type: 'construction', gender: 'male', salary_text: '일당 160,000~180,000₩', salary_min: 160000, salary_max: 180000, salary_period: 'day', employer: null, description: 'Бетонные работы и опалубка в Чхонане. Опытным больше. Работа круглый год, объекты рядом.', contact: { kind: 'phone', value: '010-2211-3344' }, minsAgo: 260 },
  { id: 'v12', city: 'jeju', work_type: 'hotel', gender: 'any', salary_text: '월 2,500,000₩ + жильё', salary_min: 2500000, salary_max: null, salary_period: 'month', employer: '제주 리조트', description: 'Отель на Чеджу: горничные, помощь на кухне, обслуживание. Жильё и питание включены.', contact: { kind: 'kakao', value: 'jeju_resort_job' }, minsAgo: 300 },
  { id: 'v13', city: 'asan', work_type: 'factory', gender: 'female', salary_text: '시급 11,800₩', salary_min: 11800, salary_max: null, salary_period: 'hour', employer: '아산 전자', description: 'Сборка электроники в Асане, чистый цех. Лёгкая работа сидя, обучение 3 дня.', contact: { kind: 'phone', value: '010-4545-6767' }, minsAgo: 340 },
  { id: 'v14', city: 'gimhae', work_type: 'agriculture', gender: 'couple', salary_text: '월 2,700,000₩ на двоих + жильё', salary_min: 2700000, salary_max: null, salary_period: 'month', employer: '김해 농원', description: 'Ферма в Кимхэ: уход за посадками и сбор урожая. Ищем пару, отдельное жильё на территории.', contact: { kind: 'phone', value: '010-6677-8899' }, minsAgo: 380 },
  { id: 'v15', city: 'ulsan', work_type: 'construction', gender: 'male', salary_text: '일당 170,000₩', salary_min: 170000, salary_max: null, salary_period: 'day', employer: '현대 협력사', description: 'Промышленная площадка в Ульсане: монтаж и покраска. Нужны с опытом, СИЗ выдаём.', contact: { kind: 'telegram', value: '@ulsan_build' }, minsAgo: 430 },
  { id: 'v16', city: 'bucheon', work_type: 'services', gender: 'any', salary_text: '시급 11,000₩', salary_min: 11000, salary_max: null, salary_period: 'hour', employer: null, description: 'Помощники по мелкому ремонту в Пучхоне. Разные задачи, гибкий график.', contact: { kind: 'phone', value: '010-1010-2020' }, minsAgo: 470 },
  { id: 'v17', city: 'seongnam', work_type: 'caregiving', gender: 'female', salary_text: '월 2,900,000₩', salary_min: 2900000, salary_max: null, salary_period: 'month', employer: '분당 요양원', description: 'Уход за пожилыми в доме престарелых (Соннам, Пундан). Дневные смены, опыт приветствуется.', contact: { kind: 'phone', value: '010-3131-4141' }, minsAgo: 520 },
  { id: 'v18', city: 'gumi', work_type: 'factory', gender: 'male', salary_text: '시급 12,200₩', salary_min: 12200, salary_max: null, salary_period: 'hour', employer: '구미 반도체', description: 'Завод в Куми: обслуживание линии. Стабильная переработка, зарплата вовремя, оформление по визе.', contact: { kind: 'kakao', value: 'gumi_line' }, minsAgo: 560 },
  { id: 'v19', city: 'goyang', work_type: 'logistics', gender: 'any', salary_text: '시급 11,300₩', salary_min: 11300, salary_max: null, salary_period: 'hour', employer: '고양 창고', description: 'Склад в Кояне: приёмка и комплектация товара. Работа стоя, ночные смены оплачиваются выше.', contact: null, minsAgo: 610 },
  { id: 'v20', city: 'pohang', work_type: 'fishery', gender: 'male', salary_text: '월 3,000,000₩', salary_min: 3000000, salary_max: null, salary_period: 'month', employer: '포항 수산', description: 'Переработка морепродуктов в Пхохане. Физическая работа, но стабильно и с проживанием.', contact: { kind: 'phone', value: '010-9911-8822' }, minsAgo: 680 },
  { id: 'v21', city: 'daejeon', work_type: 'restaurant', gender: 'any', salary_text: '시급 12,000₩', salary_min: 12000, salary_max: null, salary_period: 'hour', employer: '대전 고깃집', description: 'Корейское барбекю в Тэджоне: зал и кухня. Питание, дружный коллектив, чаевые.', contact: { kind: 'phone', value: '010-5252-6363' }, minsAgo: 720 },
  { id: 'v22', city: 'yongin', work_type: 'cleaning', gender: 'any', salary_text: '일 110,000₩', salary_min: 110000, salary_max: null, salary_period: 'day', employer: null, description: 'Клининг больших объектов в Ёнине (склады, ТЦ). Бригадная работа, развозка.', contact: { kind: 'kakao', value: 'yongin_clean' }, minsAgo: 800 },
  { id: 'v23', city: 'wonju', work_type: 'agriculture', gender: 'any', salary_text: '시급 11,000₩', salary_min: 11000, salary_max: null, salary_period: 'hour', employer: '원주 농장', description: 'Сезонная работа на полях в Вонджу: посадка и сбор. Можно без опыта, покажем всё на месте.', contact: { kind: 'phone', value: '010-7373-8484' }, minsAgo: 900 },
  { id: 'v24', city: 'gimpo', work_type: 'food', gender: 'female', salary_text: '시급 11,600₩', salary_min: 11600, salary_max: null, salary_period: 'hour', employer: '김포 식품', description: 'Фасовка готовой еды в Кимпхо. Чистый цех, лёгкая работа, удобные смены.', contact: { kind: 'phone', value: '010-1414-2525' }, minsAgo: 1000 },
  { id: 'v25', city: 'namyangju', work_type: 'construction', gender: 'male', salary_text: '일당 155,000₩', salary_min: 155000, salary_max: null, salary_period: 'day', employer: null, description: 'Отделочные работы в Намянджу: гипсокартон, шпаклёвка. Оплата в конце дня.', contact: { kind: 'telegram', value: '@nyj_remont' }, minsAgo: 1150 },
  { id: 'v26', city: 'paju', work_type: 'other', gender: 'any', salary_text: '월 2,750,000₩', salary_min: 2750000, salary_max: null, salary_period: 'month', employer: '파주 인쇄', description: 'Типография в Паджу: работа на линии печати и упаковки. Обучение, соцпакет, оформление.', contact: { kind: 'phone', value: '010-8080-9090' }, minsAgo: 1300 },
  { id: 'v27', city: 'uijeongbu', work_type: 'services', gender: 'male', salary_text: '시급 11,500₩', salary_min: 11500, salary_max: null, salary_period: 'hour', employer: null, description: 'Грузчики/помощники на переезды в Ыйджонбу. Оплата сразу, работа по вызову.', contact: { kind: 'phone', value: '010-2626-3737' }, minsAgo: 1500 },
  { id: 'v28', city: 'gwangju', work_type: 'hotel', gender: 'female', salary_text: '월 2,400,000₩', salary_min: 2400000, salary_max: null, salary_period: 'month', employer: '광주 호텔', description: 'Горничные в отеле в Кванджу. Стабильный график, дружный персонал, питание.', contact: { kind: 'kakao', value: 'gj_hotel_job' }, minsAgo: 1800 },
  { id: 'v29', city: 'gwangmyeong', work_type: 'other', gender: 'any', salary_text: '시급 11,000₩', salary_min: 11000, salary_max: null, salary_period: 'hour', employer: null, description: 'Разовая помощь на мероприятиях в Кванмёне: погрузка, монтаж, уборка. Подработка по выходным.', contact: { kind: 'phone', value: '010-4747-5858' }, minsAgo: 2100 },
  { id: 'v30', city: 'ansan', work_type: 'caregiving', gender: 'female', salary_text: '월 3,000,000₩', salary_min: 3000000, salary_max: null, salary_period: 'month', employer: '안산 요양', description: 'Сиделка/уход в Ансане, проживание с подопечным возможно. Русскоязычным будем рады.', contact: { kind: 'phone', value: '010-6161-7272' }, minsAgo: 2600 },
];

const cityBySlug = new Map(CITIES.map((c) => [c.slug, c]));

/** Build view models with real timestamps, newest first. */
export function buildVacancies(): VacancyView[] {
  const now = Date.now();
  return RAW.map((r): VacancyView => {
    const c = cityBySlug.get(r.city) ?? null;
    return {
      id: r.id,
      city: c ? { slug: c.slug, name: c.name } : null,
      region_slug: c?.region_slug ?? null,
      work_type: r.work_type,
      gender: r.gender,
      salary_text: r.salary_text,
      salary_min: r.salary_min,
      salary_max: r.salary_max,
      salary_period: r.salary_period,
      employer: r.employer,
      description: r.description,
      posted_at: new Date(now - r.minsAgo * 60000).toISOString(),
      has_contact: r.contact !== null,
      // Kept internally so the reveal endpoint can serve it; the feed strips it.
      contact: r.contact ?? undefined,
    };
  }).sort((a, b) => b.posted_at.localeCompare(a.posted_at));
}

export const DEFAULT_ME: Me = {
  public_id: 'demo-user',
  lang: 'ru',
  subscription: { city_slugs: [], work_types: [], notify: true },
};
