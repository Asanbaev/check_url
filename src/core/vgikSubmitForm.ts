/**
 * Семантический пресет полей анкеты Timepad (без ключей questionNNNNNN — они читаются из DOM).
 */
export interface VgikSubmitForm {
  surname: string;
  name: string;
  patronymic: string;
  snils: string;
  passportSeriesNumber: string;
  age: string;
  city: string;
  phone: string;
  mail: string;
  subscribeDigest: boolean;
  acceptedTerms: boolean;
}

/** Значения из прежнего getMode3Step1Payload (user_forms + чекбоксы). */
export const DEFAULT_VGIK_SUBMIT_FORM: VgikSubmitForm = {
  surname: "Асанбаева",
  name: "Софья",
  patronymic: "Вадимовна",
  snils: "18918490730",
  passportSeriesNumber: "8022494594",
  age: "18 лет",
  city: "Уфа",
  phone: "+79374745034",
  mail: "sofaasanbai@gmail.com",
  subscribeDigest: true,
  acceptedTerms: true
};
