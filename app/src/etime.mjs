// NR-02 (proposed): Ethiopian calendar + Ethiopian clock for the G1 demo.
// Verified Gregorian anchors for Meskerem 1: 2016 EC = 2023-09-12, 2017 EC = 2024-09-11,
// 2018 EC = 2025-09-11, 2019 EC = 2026-09-11, 2020 EC = 2027-09-12.
// Leap rule (same as the Coptic/Julian cycle): ዓ.ም Y is leap when (Y + 1) % 4 === 0, so the
// 366-day years are 2015, 2019, 2023 … and only they have ጳጉሜን 6.
// Verified leap anchors: ጳጉሜን 6, 2015 EC = 2023-09-11; ጳጉሜን 6, 2019 EC = 2027-09-11;
// ጳጉሜን 5, 2018 EC (common year) = 2026-09-10.
// JDN of 1 Meskerem 1 EC = ETH_EPOCH_JDN + 1 (day 1 of year 1).
export const ETH_EPOCH_JDN = 1724220;

export const ETH_MONTHS = [
  'መስከረም', 'ጥቅምት', 'ኅዳር', 'ታኅሣሥ', 'ጥር', 'የካቲት',
  'መጋቢት', 'ሚያዝያ', 'ግንቦት', 'ሰኔ', 'ሐምሌ', 'ነሐሴ', 'ጳጉሜን',
];

function gregToJdn(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

function jdnOfEthiopian(ecYear, ecMonth, ecDay) {
  return ETH_EPOCH_JDN + 365 * (ecYear - 1) + Math.floor(ecYear / 4) + 30 * (ecMonth - 1) + ecDay;
}

export function isEthiopianLeapYear(year) {
  return (year + 1) % 4 === 0;
}

export function daysInEthiopianMonth(year, month) {
  if (month >= 1 && month <= 12) return 30;
  if (month === 13) return isEthiopianLeapYear(year) ? 6 : 5;
  return 0;
}

// ልዩ የዕለት ማረጋገጫ፦ ያለመ ዕለት በግምት ወደ ቀጣዩ ዓመት አይቀየርም (F-21 የማስተዋወቂያ ጥራት)።
export function isValidEthiopianDate(year, month, day) {
  if (!Number.isInteger(year) || year < 1) return false;
  if (!Number.isInteger(month) || month < 1 || month > 13) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  return day <= daysInEthiopianMonth(year, month);
}

export function gregorianToEthiopian(date = new Date()) {
  const jdn = gregToJdn(date.getFullYear(), date.getMonth() + 1, date.getDate());
  const t = jdn - ETH_EPOCH_JDN - 1;
  const block = Math.floor(t / 1461);
  const rem = t - 1461 * block;
  // በአራት ዓመት ዑደት ውስጥ ያሉ የዓመት መነሻዎች፦ 0, 365, 730, 1096 (ሐምሌ/ዕርገት ዓመት 4ኛው ነው)።
  const index = rem >= 1096 ? 3 : rem >= 730 ? 2 : rem >= 365 ? 1 : 0;
  const year = 4 * block + index + 1;
  const doy = t - (365 * (year - 1) + Math.floor(year / 4));
  const month = Math.floor(doy / 30) + 1;
  const day = doy - 30 * (month - 1) + 1;
  return { year, month, day, month_name: ETH_MONTHS[month - 1] ?? null };
}

export function ethiopianToGregorian(year, month, day) {
  if (!isValidEthiopianDate(year, month, day)) {
    throw new Error(`INVALID_ETHIOPIAN_DATE:${year}-${month}-${day}`);
  }
  const jdn = jdnOfEthiopian(year, month, day);
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return {
    day: e - Math.floor((153 * m + 2) / 5) + 1,
    month: m + 3 - 12 * Math.floor(m / 10),
    year: 100 * b + d - 4800 + Math.floor(m / 10),
  };
}

export function ethiopianClock(date = new Date()) {
  const h = date.getHours();
  const ethHour = (h + 6) % 12 === 0 ? 12 : (h + 6) % 12;
  const gRegAm = h < 12;
  return {
    hour: ethHour,
    minute: date.getMinutes(),
    label: `ሰዓት ${ethHour}:${String(date.getMinutes()).padStart(2, '0')}`,
    period_amharic: gRegAm ? 'ጠዋት' : 'ከሰዓት',
    gregorian_24h: `${String(h).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
  };
}

// የኢትዮጵያ የዓመት ወቅቶች (NR-02 / RU-07)። የወር ቁጥር 1=መስከረም … 13=ጳጉሜን።
// የአፋን ኦሮሞ ወቅት ስሞች በጥናት ስላልተረጋገጡ null ሆነዋል። REQUIRES EVIDENCE (F-08/F-21)፦
// ድንበሮች በአማርኛና በአፋን ኦሮሞ ባለሙያ ማረጋገጥ ይጠብቃል፤ ያልተረጋገጡ ቃላት እንደ እውነት አይቀረቡም።
export const ETH_SEASONS = [
  { name: 'ክረምት', en: 'main-rain season', months: [11, 12, 13, 1], om: null },
  { name: 'በጋ', en: 'dry cool season', months: [2, 3, 4, 5], om: null },
  { name: 'ኮበል', en: 'small-rain season', months: [6, 7, 8], om: null },
  { name: 'ዳዝ', en: 'hot pre-rain season', months: [9, 10], om: null },
];

export function seasonOf(eth) {
  const m = eth?.month;
  if (!m) return null;
  const season = ETH_SEASONS.find((s) => s.months.includes(m));
  if (!season) return null;
  return { name: season.name, en: season.en, om: season.om, months: season.months };
}

export function ethiopianToGregorianDate(year, month, day) {
  const g = ethiopianToGregorian(year, month, day);
  return new Date(g.year, g.month - 1, g.day);
}

export function describeNow(date = new Date()) {
  const eth = gregorianToEthiopian(date);
  return {
    iso_utc: date.toISOString(),
    ethiopian: eth,
    ethiopian_time: ethiopianClock(date),
    season: seasonOf(eth),
    note: 'የኢትዮጵያ ዕለት/ሰዓት ስሌት በG1 ላይ ተፈትሿል፤ የማረጋገጫ ቅደም ተከተል (G0) ገና በባለቤት ውሳኔ ይጠብቃል (NR-02፣ F-21)።',
  };
}
