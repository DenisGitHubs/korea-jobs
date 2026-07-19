// lib/korea/core/labels.ts
//
// Shared RU display labels for enum-ish backend values. Single source of truth so the
// several places that render a work_type into a human string (notify DM text, report DM
// text, ...) never drift. UI-facing labels for the mini app live in app/ (Frodo); this is
// only for backend-composed text such as bot DMs.

/** work_type enum → short RU label used in bot messages. */
export const WORK_TYPE_LABEL_RU: Record<string, string> = {
  factory: 'Завод',
  construction: 'Стройка',
  agriculture: 'Поле, ферма',
  fishery: 'Рыбзавод',
  food: 'Пищёвка',
  logistics: 'Склад',
  restaurant: 'Общепит',
  cleaning: 'Уборка',
  caregiving: 'Уход',
  hotel: 'Отель',
  services: 'Услуги',
  other: 'Другое',
};

/** Resolve a work_type to its RU label, falling back to the raw code for an unknown value. */
export function workTypeLabelRu(workType: string): string {
  return WORK_TYPE_LABEL_RU[workType] ?? workType;
}
