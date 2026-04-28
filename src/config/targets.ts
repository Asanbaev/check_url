export type SearchMode = "contains" | "not_contains";

export interface MonitorTarget {
  name: string;
  /** GITIS | VGIK | RGSI — связь с таблицей theater в БД */
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
  intHour: number;
  intMin: number;
}

export const targets: MonitorTarget[] = [
  {
    name: "GITIS_Меньшиков",
    theaterId: "GITIS",
    enabled: true,
    url: "https://admission.gitis.net/242",
    searchText: "свободных дат пока нет",
    searchMode: "contains",
    waitForSelector: false,
    requested: false,
    requestedTime: "2025-04-01 15:00:00",
    stage: 0,
    intHour: 3,
    intMin: 3
  },
  {
    name: "GITIS_Блохин",
    theaterId: "GITIS",
    enabled: false,
    url: "https://admission.gitis.net/243",
    searchText: "свободных дат пока нет",
    searchMode: "contains",
    waitForSelector: false,
    requested: false,
    requestedTime: "2025-04-01 15:00:00",
    stage: 0,
    intHour: 3,
    intMin: 3
  },
  {
    name: "GITIS_Кудряшов",
    theaterId: "GITIS",
    enabled: true,
    url: "https://admission.gitis.net/244",
    searchText: "Свободных дат пока нет",
    searchMode: "contains",
    waitForSelector: false,
    requested: false,
    requestedTime: "2025-02-01 15:00:00",
    stage: 0,
    intHour: 3,
    intMin: 3
  },
  {
    name: "VGIK_Май",
    theaterId: "VGIK",
    enabled: false,
    url: "https://vgik.info/abiturient/higher/spetsialitet/aktyerskiy-fakultet/",
    searchText: " мая ",
    searchMode: "not_contains",
    waitForSelector: false,
    requested: false,
    requestedTime: "2025-04-01 15:00:00",
    stage: 0,
    intHour: 3,
    intMin: 2
  },
  {
    name: "VGIK_Грамматиков_06",
    theaterId: "VGIK",
    enabled: false,
    url: "https://priemvgik.timepad.ru/event/3349852/",
    searchText: "регистрация на предварительное прослушивание закрыта, так как все места уже заняты!",
    searchMode: "contains",
    waitForSelector: true,
    requested: false,
    requestedTime: "2025-02-01 15:00:00",
    stage: 0,
    intHour: 3,
    intMin: 3
  },
  {
    name: "VGIK_Грамматиков_15",
    theaterId: "VGIK",
    enabled: false,
    url: "https://priemvgik.timepad.ru/event/3349855/",
    searchText: "регистрация на предварительное прослушивание закрыта, так как все места уже заняты!",
    searchMode: "contains",
    waitForSelector: true,
    requested: false,
    requestedTime: "2025-02-01 15:00:00",
    stage: 0,
    intHour: 3,
    intMin: 3
  },
  {
    name: "VGIK_Грамматиков_16",
    theaterId: "VGIK",
    enabled: false,
    url: "https://priemvgik.timepad.ru/event/3349863/",
    searchText: "регистрация на предварительное прослушивание закрыта, так как все места уже заняты!",
    searchMode: "contains",
    waitForSelector: true,
    requested: false,
    requestedTime: "2025-02-01 15:00:00",
    stage: 0,
    intHour: 3,
    intMin: 3
  },
  {
    name: "VGIK_Вдовиченков_12",
    theaterId: "VGIK",
    enabled: false,
    url: "https://priemvgik.timepad.ru/event/3320951/",
    searchText: "регистрация на предварительное прослушивание закрыта, так как все места уже заняты!",
    searchMode: "contains",
    waitForSelector: true,
    requested: false,
    requestedTime: "2025-02-01 15:00:00",
    stage: 0,
    intHour: 3,
    intMin: 3
  },
  {
    name: "VGIK_Вдовиченков_22",
    theaterId: "VGIK",
    enabled: false,
    url: "https://priemvgik.timepad.ru/event/3349795/",
    searchText: "регистрация на предварительное прослушивание закрыта, так как все места уже заняты!",
    searchMode: "contains",
    waitForSelector: true,
    requested: false,
    requestedTime: "2025-02-01 15:00:00",
    stage: 0,
    intHour: 3,
    intMin: 3
  },
  {
    name: "VGIK_Вдовиченков_23",
    theaterId: "VGIK",
    enabled: false,
    url: "https://priemvgik.timepad.ru/event/3349816/",
    searchText: "регистрация на предварительное прослушивание закрыта, так как все места уже заняты!",
    searchMode: "contains",
    waitForSelector: true,
    requested: false,
    requestedTime: "2025-02-01 15:00:00",
    stage: 0,
    intHour: 3,
    intMin: 3
  },
  {
    name: "VGIK_Вдовиченков_30",
    theaterId: "VGIK",
    enabled: false,
    url: "https://priemvgik.timepad.ru/event/3349846/",
    searchText: "регистрация на предварительное прослушивание закрыта, так как все места уже заняты!",
    searchMode: "contains",
    waitForSelector: true,
    requested: false,
    requestedTime: "2025-02-01 15:00:00",
    stage: 0,
    intHour: 3,
    intMin: 3
  },
  {
    name: "VGIK_Вдовиченков_25",
    theaterId: "VGIK",
    enabled: false,
    url: "https://priemvgik.timepad.ru/event/3320962/",
    searchText: "регистрация на предварительное прослушивание закрыта, так как все места уже заняты!",
    searchMode: "contains",
    waitForSelector: true,
    requested: false,
    requestedTime: "2025-02-01 15:00:00",
    stage: 0,
    intHour: 3,
    intMin: 2
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
    intHour: 3,
    intMin: 3
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
    intHour: 3,
    intMin: 3
  }
];
