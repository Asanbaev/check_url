export type SearchMode = "contains" | "not_contains";

/** Подпись в алертах и логах: `<theaterId>_<name>` (в конфиге `name` без префикса театра). */
export function targetDisplayLabel(t: Pick<MonitorTarget, "theaterId" | "name">): string {
  return `${t.theaterId}_${t.name}`;
}

export interface MonitorTarget {
  name: string;
  /** GITIS | VGIK | RGSI | SHEPKIN — связь с таблицей theater в БД */
  theaterId: string;
  enabled: boolean;
  url: string;
  searchText: string;
  searchMode: SearchMode;
  waitForSelector: boolean;
  requested: boolean;
  requestedTime: string;
  stage: number;
  datePast?: string;
  msgElapsedHours: number;
}

export const targets: MonitorTarget[] = [
  {
    name: "Меньшиков",
    theaterId: "GITIS",
    enabled: false,
    url: "https://admission.gitis.net/242",
    searchText: "свободных дат пока нет",
    searchMode: "contains",
    waitForSelector: false,
    requested: false,
    requestedTime: "2025-04-01 15:00:00",
    stage: 0,
    msgElapsedHours: 3
  },
  {
    name: "Блохин",
    theaterId: "GITIS",
    enabled: false,
    url: "https://admission.gitis.net/243",
    searchText: "свободных дат пока нет",
    searchMode: "contains",
    waitForSelector: false,
    requested: false,
    requestedTime: "2025-04-01 15:00:00",
    stage: 0,
    msgElapsedHours: 3
  },
  {
    name: "Кудряшов",
    theaterId: "GITIS",
    enabled: true,
    url: "https://admission.gitis.net/244",
    searchText: "Свободных дат пока нет",
    searchMode: "contains",
    waitForSelector: false,
    requested: false,
    requestedTime: "2025-02-01 15:00:00",
    stage: 0,
    msgElapsedHours: 3
  },
  {
    name: "Форма",
    theaterId: "SHEPKIN",
    enabled: true,
    url: "https://shepkinskoe.ru/forma/",
    searchText: "временно заблокирована до окончания обработки",
    searchMode: "contains",
    waitForSelector: false,
    requested: false,
    requestedTime: "2026-02-01 15:00:00",
    stage: 0,
    msgElapsedHours: 3
  },
  { // есть по опции 3 статуса: 1-поиск мая, 2-поиск ссылок более какой то цифры, задаётся по ссылке, найди max и укажи   3.пытается отправить POST
    name: "New",
    theaterId: "VGIK",
    enabled: true,
    url: "https://vgik.info/abiturient/higher/spetsialitet/aktyerskiy-fakultet/",
    searchText: " мая ",
    searchMode: "not_contains",
    waitForSelector: false,
    requested: false,
    requestedTime: "2026-04-01 15:00:00",
    stage: 0,
    msgElapsedHours: 3
  },
  {
    name: "Мерзликин_13",
    theaterId: "VGIK",
    enabled: true,
    url: "https://priemvgik.timepad.ru/event/3951178/",
    searchText: "регистрация на предварительное прослушивание закрыта, так как все места уже заняты!",
    searchMode: "contains",
    waitForSelector: true,
    requested: false,
    requestedTime: "2025-02-01 15:00:00",
    stage: 0,
    msgElapsedHours: 3
  },
  {
    name: "Мерзликин_12",
    theaterId: "VGIK",
    enabled: true,
    url: "https://priemvgik.timepad.ru/event/3951176/",
    searchText: "регистрация на предварительное прослушивание закрыта, так как все места уже заняты!",
    searchMode: "contains",
    waitForSelector: true,
    requested: false,
    requestedTime: "2025-02-01 15:00:00",
    stage: 0,
    msgElapsedHours: 3
  },
  {
    name: "Мерзликин_15",
    theaterId: "VGIK",
    enabled: true,
    url: "https://priemvgik.timepad.ru/event/3951179/",
    searchText: "регистрация на предварительное прослушивание закрыта, так как все места уже заняты!",
    searchMode: "contains",
    waitForSelector: true,
    requested: false,
    requestedTime: "2025-02-01 15:00:00",
    stage: 0,
    msgElapsedHours: 3
  },
  {
    name: "Мерзликин_20",
    theaterId: "VGIK",
    enabled: true,
    url: "https://priemvgik.timepad.ru/event/3951181/",
    searchText: "регистрация на предварительное прослушивание закрыта, так как все места уже заняты!",
    searchMode: "contains",
    waitForSelector: true,
    requested: false,
    requestedTime: "2025-02-01 15:00:00",
    stage: 0,
    msgElapsedHours: 3
  },
  {
    name: "Федоров_7",
    theaterId: "VGIK",
    enabled: true,
    url: "https://priemvgik.timepad.ru/event/3951188/",
    searchText: "регистрация на предварительное прослушивание закрыта, так как все места уже заняты!",
    searchMode: "contains",
    waitForSelector: true,
    requested: false,
    requestedTime: "2025-02-01 15:00:00",
    stage: 0,
    msgElapsedHours: 3
  },
  {
    name: "Федоров_14",
    theaterId: "VGIK",
    enabled: true,
    url: "https://priemvgik.timepad.ru/event/3951191/",
    searchText: "регистрация на предварительное прослушивание закрыта, так как все места уже заняты!",
    searchMode: "contains",
    waitForSelector: true,
    requested: false,
    requestedTime: "2025-02-01 15:00:00",
    stage: 0,
    msgElapsedHours: 3
  },
  {
    name: "rgsi_Смирнов",
    theaterId: "RGSI",
    enabled: false,
    url: "https://portal.rgisi.ru/abiturient/theateranketa",
    searchText: "В настоящий момент свободных дат для записи нет",
    searchMode: "contains",
    waitForSelector: false,
    requested: false,
    requestedTime: "2025-04-01 15:00:00",
    stage: 0,
    msgElapsedHours: 3
  },
  {
    name: "rgsi_Стукалов",
    theaterId: "RGSI",
    enabled: false,
    url: "https://portal.rgisi.ru/abiturient/theateranketa",
    searchText: "В настоящий момент свободных дат для записи нет",
    searchMode: "contains",
    waitForSelector: false,
    requested: false,
    requestedTime: "2025-04-01 15:00:00",
    stage: 0,
    msgElapsedHours: 3
  }
];
