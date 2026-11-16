import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysInEthiopianMonth,
  describeNow,
  ethiopianClock,
  ethiopianToGregorian,
  ethiopianToGregorianDate,
  ETH_EPOCH_JDN,
  ETH_MONTHS,
  ETH_SEASONS,
  gregorianToEthiopian,
  isEthiopianLeapYear,
  isValidEthiopianDate,
  seasonOf,
} from '../app/src/etime.mjs';

test('NR-02 / RU-07፦ የኢትዮጵያ ዘመን መሠረታዊ እሴት እና እንቁጣጣሽ', () => {
  assert.equal(ETH_EPOCH_JDN, 1724220);
  assert.equal(ETH_MONTHS.length, 13);
  assert.equal(ETH_MONTHS[0], 'መስከረም');
  assert.equal(ETH_MONTHS[12], 'ጳጉሜን');
  // የተረጋገጡ መሠረቶች (እንቁጣጣሽ)፦ 1 መስከረም 2016/2017/2018/2019/2020 ዓ.ም
  const newYear = [
    [2016, 2023, 9, 12],
    [2017, 2024, 9, 11],
    [2018, 2025, 9, 11],
    [2019, 2026, 9, 11],
    [2020, 2027, 9, 12],
  ];
  for (const [ey, gy, gm, gd] of newYear) {
    const eq = gregorianToEthiopian(new Date(gy, gm - 1, gd));
    assert.deepEqual([eq.year, eq.month, eq.day, eq.month_name], [ey, 1, 1, 'መስከረም'], `${ey} ዓ.ም እንቁጣጣሽ`);
  }
  // ዛሬ (2026-11-04) = 2019 ዓ.ም ጥቅምት 25
  const today = gregorianToEthiopian(new Date(2026, 10, 4));
  assert.deepEqual([today.year, today.month, today.day], [2019, 2, 25]);
});

test('NR-02 / RU-07፦ ወደ ኋላና ወደ ፊት ልወጣ ተገላቢጦሽ ነው (round-trip)', () => {
  for (const y of [2024, 2025, 2026, 2027]) {
    for (const m of [0, 5, 11]) {
      for (const d of [1, 15, 28]) {
        const src = new Date(y, m, d);
        const ec = gregorianToEthiopian(src);
        const back = ethiopianToGregorianDate(ec.year, ec.month, ec.day);
        assert.equal(back.getFullYear(), src.getFullYear(), `${y}-${m}-${d} year`);
        assert.equal(back.getMonth(), src.getMonth(), `${y}-${m}-${d} month`);
        assert.equal(back.getDate(), src.getDate(), `${y}-${m}-${d} day`);
      }
    }
  }
});

test('NR-02 / R-41፦ 120 ዓመታት ሙሉ ቀናት ተገላቢጦሽ ያልፋሉ (exhaustive sweep)', () => {
  // 1993 እስከ 2112 (≈120 ዓመት፣ 30+ ዕርገት ዓመታትን ይሸፍናል)፤ የሰዓት ቀጠና ጣልቃ ገብነት ለማስወገድ ቦታዊ ዕለት ይጠቀማል
  let days = 0;
  for (let y = 1993; y <= 2112; y += 1) {
    for (let m = 0; m < 12; m += 1) {
      const dim = new Date(y, m + 1, 0).getDate();
      for (let d = 1; d <= dim; d += 1) {
        const src = new Date(y, m, d);
        const ec = gregorianToEthiopian(src);
        assert.ok(isValidEthiopianDate(ec.year, ec.month, ec.day), `ያለመ ዕለት ተመልሷል፦ ${ec.year}-${ec.month}-${ec.day}`);
        const back = ethiopianToGregorian(ec.year, ec.month, ec.day);
        assert.deepEqual(
          [back.year, back.month, back.day],
          [src.getFullYear(), src.getMonth() + 1, src.getDate()],
          `round-trip ${y}-${m + 1}-${d}`,
        );
        days += 1;
      }
    }
  }
  assert.ok(days > 43000, `በፈተናው የተሸፈኑ ቀናት፦ ${days}`);
});

test('NR-02 / R-41፦ ዕርገት ዓመት — ጳጉሜን 6 በ(ዓ.ም+1)%4==0 ብቻ ይኖራል', () => {
  assert.equal(isEthiopianLeapYear(2015), true);
  assert.equal(isEthiopianLeapYear(2019), true);
  assert.equal(isEthiopianLeapYear(2016), false);
  assert.equal(isEthiopianLeapYear(2018), false);
  // 2015 ዓ.ም የመጨረሻ ቀን ጳጉሜን 6 = 2023-09-11፤ ቀጥሎ 1 መስከረም 2016 = 2023-09-12
  assert.deepEqual(ethiopianToGregorian(2015, 13, 6), { year: 2023, month: 9, day: 11 });
  assert.deepEqual(ethiopianToGregorian(2016, 1, 1), { year: 2023, month: 9, day: 12 });
  // 2019 ዓ.ም (የሐምሌ ዕርገት ዓመት)፦ ጳጉሜን 6 = 2027-09-11፣ 2020 ዓ.ም እንቁጣጣሽ = 2027-09-12
  assert.deepEqual(ethiopianToGregorian(2019, 13, 6), { year: 2027, month: 9, day: 11 });
  assert.deepEqual(ethiopianToGregorian(2020, 1, 1), { year: 2027, month: 9, day: 12 });
  // ዕርገት ያልሆነ ዓመት፦ ጳጉሜን 5 የመጨረሻው ቀን ነው
  assert.deepEqual(ethiopianToGregorian(2018, 13, 5), { year: 2026, month: 9, day: 10 });
  assert.equal(daysInEthiopianMonth(2018, 13), 5);
  assert.equal(daysInEthiopianMonth(2019, 13), 6);
  assert.equal(daysInEthiopianMonth(2019, 1), 30);
  // ያለመ ዕለት በግምት ወደ ቀጣዩ ዓመት አይቀየርም (የተገኘ እውነተኛ ጉድለት ነበር)
  assert.equal(isValidEthiopianDate(2018, 13, 6), false);
  assert.throws(() => ethiopianToGregorian(2018, 13, 6), /INVALID_ETHIOPIAN_DATE/);
  assert.equal(isValidEthiopianDate(2019, 13, 6), true);
  assert.equal(isValidEthiopianDate(2019, 14, 1), false);
  assert.equal(isValidEthiopianDate(2019, 1, 31), false);
  assert.equal(isValidEthiopianDate(2019, 0, 1), false);
  assert.equal(isValidEthiopianDate(2019.5, 1, 1), false);
});

test('NR-02 / RU-07፦ የኢትዮጵያ ሰዓት (+6) ልወጣ', () => {
  const morning = ethiopianClock(new Date(2026, 10, 4, 7, 30));
  assert.equal(morning.hour, 1);
  assert.equal(morning.period_amharic, 'ጠዋት');
  const afternoon = ethiopianClock(new Date(2026, 10, 4, 15, 0));
  assert.equal(afternoon.hour, 9);
  assert.equal(afternoon.period_amharic, 'ከሰዓት');
  // ማቪ 12፦ (12+6)%12 = 6
  assert.equal(ethiopianClock(new Date(2026, 10, 4, 12, 0)).hour, 6);
  // ሌሊት 00፦ 6 ሰዓት (ከሰዓት)
  assert.equal(ethiopianClock(new Date(2026, 10, 4, 0, 0)).hour, 6);
});

test('NR-02 / RU-07፦ አርባዊ ወቅቶች በወሩ መሠረት ይለያያሉ', () => {
  assert.equal(seasonOf({ month: 12 }).name, 'ክረምት'); // ነሐሴ
  assert.equal(seasonOf({ month: 1 }).name, 'ክረምት'); // መስከረም
  assert.equal(seasonOf({ month: 13 }).name, 'ክረምት'); // ጳጉሜን
  assert.equal(seasonOf({ month: 2 }).name, 'በጋ'); // ጥቅምት
  assert.equal(seasonOf({ month: 5 }).name, 'በጋ'); // ጥር
  assert.equal(seasonOf({ month: 6 }).name, 'ኮበል'); // የካቲት
  assert.equal(seasonOf({ month: 8 }).name, 'ኮበል'); // ሚያዝያ
  assert.equal(seasonOf({ month: 9 }).name, 'ዳዝ'); // ግንቦት
  assert.equal(seasonOf({ month: 10 }).name, 'ዳዝ'); // ሰኔ
  assert.equal(seasonOf(null), null);
  // 13ኛው ወር ጨምሮ እያንዳንዱ ወር በአንድና አንድ ወቅት ብቻ ይሸፈናል
  const covered = ETH_SEASONS.flatMap((s) => s.months);
  assert.equal(covered.length, 13, '13 ወሮች ሁሉ ተሸፍነዋል');
  assert.equal(new Set(covered).size, 13, 'ወሮች አይደጋገሙም');
  // የአፋን ኦሮሞ ወቅት ስሞች ያልተረጋገጡ ናቸው — በስህተት አይቀረቡም (F-08)
  assert.ok(ETH_SEASONS.every((s) => s.om === null), 'የተረጋገጠ የአፋን ኦሮሞ ወቅት ስም እስካልተገኘ ድረስ null');
});

test('NR-02 / R-41፦ ዛሬው እርግጠኛ ልወጣ ወደ አማርኛ ሪፖርት ይዞራል፤ G0 ውሳኔ ግን ይጠብቃል', () => {
  const d = describeNow(new Date(2026, 10, 4, 10, 0));
  assert.equal(d.ethiopian.year, 2019);
  assert.equal(d.ethiopian.month_name, 'ጥቅምት');
  assert.equal(d.season.name, 'በጋ');
  assert.equal(d.ethiopian_time.hour, 4);
  assert.ok(d.iso_utc.includes('2026'));
  assert.match(d.note, /NR-02|F-21|ባለቤት/, 'የባለቤት ውሳኔ ጥያቄ ግልጽ መሆን አለበት');
});
