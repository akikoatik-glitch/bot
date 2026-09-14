'use strict';

// Arabic phrase library for human-like channel posts.
// All text is Arabic-only (no Saudi flag, no English filler, no guarantee
// claims like "مضمون" / "ربح مضمون"). Each group has many variations;
// pick() rotates through them deterministically so consecutive posts differ.

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
function toArDigits(n) {
  return String(n).replace(/[0-9]/g, c => AR_DIGITS[parseInt(c, 10)]);
}

// Deterministic rotation: same bucket always returns the same index *for a
// given seed*; the seed is bumped by callers each time they post.
function pickFrom(list, seed) {
  if (!list || !list.length) return '';
  return list[Math.abs(seed) % list.length];
}

const MORNING_GREETINGS = [
  'صباح الخير ⚽ اليوم مليء بالفرص، اخترنا لكم الأبرز.',
  'صباح الذهب 🥇 جملتا اليوم جاهزتين بعد الدراسة الكاملة.',
  'يوم جديد ومباريات جديدة 🔥 إليكم أفضل خلاصة النموذج.',
  'مرحباً بكم في يوم كروي جديد 📊 اخترنا لكم ما يستحق المتابعة.',
  'صباح الفل 🌅 فحصنا كل مواجهات اليوم وتركنا فقط الفرص المثيرة.',
  'أهلاً بكم 👋 اليوم عندنا باقة مختارة بعناية. كونوا في الموعد.',
  'يومكم أبيض 💪 سنبدأ نشر التوقعات قبل كل مباراة بثلاث ساعات.',
  'صباح النجوم ⭐ نحلل ونختار، وأنتم تتابعون وتستمتعون.',
];

const PREDICTION_HEADERS = [
  'توقعاتنا للمباراة',
  'تحليل النموذج',
  'قرار النموذج',
  'قراءتنا للقاء',
  'ملاحظة المحلل',
];

const PREDICTION_INTROS = [
  'أعطتنا الدراسة سوقاً واحداً قوياً، وهذا ما سنعتمد عليه.',
  'بعد فحص الأرقام والمواجهات السابقة، اخترنا:',
  'النموذج رشّح لنا الخيار الأرجح لهذا اللقاء:',
  'خلصنا التحليل، والتوقع الذي نثق به اليوم:',
];

const CONFIDENCE_LABELS = {
  ELITE: 'ثقة إحصائية عالية جداً',
  STRONG: 'ثقة إحصائية عالية',
  GOOD: 'ثقة إحصائية جيدة',
};

const DISCLAIMERS = [
  'توقعات إحصائية وليست نتيجة مؤكدة، ننصحكم بالمراهنة بمسؤولية.',
  'هذه قراءة رياضية للاحتمالات، والقرار النهائي يعود إليكم.',
  'النموذج يعطي الاحتمال الأرجح وليس ضماناً للنتيجة، العب بوعي.',
];

const WIN_REPLIES = [
  '💰 التوقع تحقق بفضل الله، كل من تابع معنا كان معه.',
  '🔥 إصابة في الخدمة! التوقع الرابح وصل.',
  '🎯 نجحنا من جديد، والدرس واضح لمن يتابع الأرقام.',
  '✅ لا جديد، الأرقام لا تكذب.',
  'جولة خضراء أخرى 🟢 والمحلل يبتسم هذا المساء.',
  '⭐ توقعنا وصل، والمحظوظين من لحقوا به.',
];

const LOSS_REPLIES = [
  '❌ كرة القدم لا تعرف الكمال، هذا اللقاء خالف التوقعات. نعاود غداً بقوة.',
  'سيطرنا أسبوعاً كاملاً والخسارة جزء من اللعبة 🤝 هذا لا يثنينا.',
  'لم تسر الأمور كما توقعنا هذه المرة. الأرقام تبقى معيارنا وغداً جديد.',
  'المباريات هكذا، ليست كلها تصب في صالح المتوقع ⚽ نكمل.',
  'نتحمل النتيجة بشفافية، هذا باب الصدق في التوقعات 💪.',
];

const EVENING_SUMMARIES = [
  'ملخص اليوم 📊 نهاية النهار، إليكم حصيلة توقعاتنا الصادقة.',
  'قبل النوم، فاصل من الحقيقة 🤝 هذا ما قدّمناه اليوم من نتائج.',
  'خبر اليوم مساءً ⭐ نعرض لكم الحصيلة كاملة بدون تجميل.',
];

const SUMMARY_GOOD = [
  'يوم جيد بلا شك، معاً نحو الأمام 🔥',
  'حصيلة ممتازة اليوم، المحلل سعيد بهذا الشكل 📈',
];
const SUMMARY_OK = [
  'حصيلة مقبولة، والصورة أوضح مع الوقت 📊',
  'نتائج متوسطة اليوم، نتعلم ونحسّن النموذج كل أسبوع 📈',
];
const SUMMARY_BAD = [
  'يوم لم نرتَح له، لكننا نتعلم ونعود أقوى 💪',
  'نتائج اليوم لم تكن في صالحنا، سنصحح المسار غداً 📉',
];
const SUMMARY_ZERO = [
  'لا توقعات منشورة اليوم، نلتقي غداً صباحاً ⚽',
  'يوم هادئ بلا منشورات، إن شاء الله غداً أوفر 🔥',
];

// ── export API ──────────────────────────────────────────────────────────────

const phrases = {
  MORNING_GREETINGS,
  PREDICTION_HEADERS,
  PREDICTION_INTROS,
  CONFIDENCE_LABELS,
  DISCLAIMERS,
  WIN_REPLIES,
  LOSS_REPLIES,
  EVENING_SUMMARIES,
  SUMMARY_GOOD,
  SUMMARY_OK,
  SUMMARY_BAD,
  SUMMARY_ZERO,
};

function pick(kind, seed) {
  const v = phrases[kind];
  if (!Array.isArray(v)) return v || '';
  return pickFrom(v, seed);
}

module.exports = { phrases, pick, pickFrom, toArDigits };