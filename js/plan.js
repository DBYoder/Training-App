/*
 * SWAP 12-Week Advanced Marathon Plan, transcribed from the source markdown.
 * The distance ranges create multiple plans in one: low end of the range is
 * intermediate, high end is for advanced athletes with a big base.
 *
 * Day types: rest | easy | workout | long | race
 * The plan grid runs Mon–Sun with the marathon on Sunday of Week 12.
 */
const PLAN_WEEKS = [
  {
    week: 1,
    days: [
      {
        dow: "Mon", type: "rest", title: "Rest day",
        details: [
          "Rest. Heat idea like sauna or hot tub. You can be active with a light bike or hike, but full rest is great!",
        ],
      },
      {
        dow: "Tue", type: "easy", title: "8–12 mi easy + 6 × 20 sec hills",
        details: [
          "8–12 mi easy plus 6 × 20 second hills. On easy running, think light on feet and quick strides, keeping effort relaxed. The hill strides can be anytime in the 2nd half, building into them and working on peak power on a 4–8% grade.",
          "Intro <a href=\"https://www.patreon.com/posts/109257823\" target=\"_blank\" rel=\"noopener\">Core Snack</a> routine. Aim to do this routine 1–2 × per day most days ahead.",
          "Note: very high-volume athletes could add a very easy double on Tuesdays that don’t precede time trials.",
        ],
      },
      {
        dow: "Wed", type: "workout", title: "16 × 1 min fast/easy + 1 mi moderate",
        details: [
          "3 mi easy warm-up with a couple strides, 16 × 1 min fast/1 min easy (think 5k effort on speed, with the easy recovery at relaxed effort), 1 mi moderate (think marathon effort), 2 miles easy. The vVO2 intervals into M-effort work will be taxing at first!",
          "Optional uphill treadmill or x-train double. Uphill treadmill is 10–15% grade in Z2 HR for 30–45 min. X-train can be bike, elliptical, or similar for 30–60 min. For very advanced athletes, any double can be a <a href=\"https://www.patreon.com/posts/heat-suit-101-121132624?l=es\" target=\"_blank\" rel=\"noopener\">heat suit</a>.",
          "Strength option: <a href=\"https://www.trailrunnermag.com/training/trail-tips-training/3-minute-mountain-legs\" target=\"_blank\" rel=\"noopener\">mountain legs</a>, 2 × 10 reps back squats, 2 × 20 back extensions.",
        ],
      },
      {
        dow: "Thu", type: "easy", title: "8–12 mi easy or 1.5–2.5 hr x-train",
        details: [
          "8–12 mi easy or 1.5–2.5 hours easy/mod x-train. X-train like cycling is ideal if you are lower mileage or beat up at all from the workouts. With x-train, you can push harder if you feel good!",
          "Optional easy double or uphill TM. Only do a Thursday double if you are a higher-volume athlete with lots of time!",
        ],
      },
      {
        dow: "Fri", type: "easy", title: "6–10 mi easy + 4 × 20 sec hills",
        details: [
          "6–10 mi easy plus 4 × 20 sec hills. Fridays are very easy before weekend long runs.",
          "Heat ideal.",
        ],
      },
      {
        dow: "Sat", type: "long", title: "Long run: 12–16 mi easy/mod",
        details: [
          "12–16 mi easy/mod. On this first easy/mod day, the goal is to run with some intention, Z2/Z3 flow. Focus on form and slight forward lean.",
        ],
      },
      {
        dow: "Sun", type: "easy", title: "8–12 mi easy + 6 × 30 sec hills and/or x-train",
        details: [
          "8–12 mi easy plus 6 × 30 second hills at the end and/or longer x-train. Sunday is always an adventure flex day! The power hills at the end will be a fatigue-resistance day at the end of a long week.",
          "Full strength: same routine, adding deadlifts (ideally hex bar) if you have access.",
        ],
      },
    ],
  },
  {
    week: 2,
    days: [
      {
        dow: "Mon", type: "rest", title: "Rest day",
        details: ["Rest. Heat ideal."],
      },
      {
        dow: "Tue", type: "easy", title: "8–12 mi easy + 5 × 20 sec strides",
        details: [
          "8–12 mi easy with 5 × 20 seconds fast/2 min easy. On these <a href=\"https://www.patreon.com/posts/how-to-strides-107808057\" target=\"_blank\" rel=\"noopener\">first flatter strides</a>, relax into them to avoid pulling a muscle, trying to hit the fastest pace you can without sprinting.",
        ],
      },
      {
        dow: "Wed", type: "workout", title: "8 × 2 min + 6 × 1 min intervals",
        details: [
          "3 mi easy warm-up with a couple strides, 8 × 2 min fast/1 min easy (think 10k effort, with light progression as you go), 3 min easy, 6 × 1 min fast/1 min easy (think 5k to 3k effort), 2–3 mi easy cooldown.",
          "Optional uphill TM or x-train double.",
          "Full strength.",
        ],
      },
      {
        dow: "Thu", type: "easy", title: "8–12 mi easy or 1.5–2.5 hr x-train",
        details: [
          "8–12 mi easy or 1.5–2.5 hours easy/mod x-train.",
          "Optional easy double or uphill TM.",
        ],
      },
      {
        dow: "Fri", type: "easy", title: "6–10 mi easy + 4 × 20 sec hills",
        details: ["6–10 mi easy plus 4 × 20 sec hills.", "Heat ideal."],
      },
      {
        dow: "Sat", type: "long", title: "Long run: 14–18 mi with 6 × 5 min @ 1-hr effort",
        details: [
          "14–18 mi easy/mod with 6 × 5 min around 1-hour effort with 2 min easy after each. Do these intervals after a few mile warm-up, thinking threshold effort, which feels rather comfortable at first.",
        ],
      },
      {
        dow: "Sun", type: "easy", title: "10–14 mi easy and/or longer x-train",
        details: ["10–14 mi easy and/or longer x-train.", "Full strength routine."],
      },
    ],
  },
  {
    week: 3,
    days: [
      {
        dow: "Mon", type: "rest", title: "Rest day",
        details: ["Rest. Heat ideal."],
      },
      {
        dow: "Tue", type: "workout", title: "5 × 3 min hills + 15 min @ M effort",
        details: [
          "3 mi easy warm-up with a couple strides, 5 × 3 min hills mod/hard (think 5k) with run-down recovery, 15 min at M effort on tired legs, 2–3 mi easy cooldown.",
          "Optional uphill TM or x-train double.",
          "The workout will feel extra tough with muscular fatigue and lactate accumulation!",
        ],
      },
      {
        dow: "Wed", type: "easy", title: "8–12 mi very easy",
        details: ["8–12 mi very easy.", "Keep this day very relaxed!"],
      },
      {
        dow: "Thu", type: "workout", title: "Steady run: 8–10 mi easy/mod to mod",
        details: [
          "8–10 mi easy/mod to mod, warming up well and doing purposeful flow, 2–3 mi easy.",
          "Optional easy double or uphill TM.",
          "Full strength.",
          "This steady run will have direct translation to marathon ability later.",
        ],
      },
      {
        dow: "Fri", type: "easy", title: "6–10 mi easy + 4 × 20 sec strides",
        details: ["6–10 mi easy with 4 × 20 sec fast/2 min easy.", "Heat ideal."],
      },
      {
        dow: "Sat", type: "long", title: "Long run: 16–20 mi easy over hills",
        details: [
          "16–20 mi easy over hills, with full fueling and hydration, aiming to finish feeling good at the end. Building up that long-run volume!",
        ],
      },
      {
        dow: "Sun", type: "easy", title: "10–14 mi easy + 6 × 30 sec hills and/or x-train",
        details: [
          "10–14 mi easy plus 6 × 30 sec hills at the end and/or longer x-train.",
          "Full strength routine.",
        ],
      },
    ],
  },
  {
    week: 4,
    days: [
      {
        dow: "Mon", type: "rest", title: "Rest day",
        details: ["Rest. Heat ideal."],
      },
      {
        dow: "Tue", type: "easy", title: "8–12 mi easy + 5 × 20 sec hills",
        details: ["8–12 mi easy plus 5 × 20 second hills."],
      },
      {
        dow: "Wed", type: "workout", title: "Track: 4–5 × 800/400/200 + 4 × 200",
        details: [
          "3 mi easy warm-up with a couple strides, 4–5 × 800/400/200 fast — 400 easy after the 800s, 200 easy after the 400s, 400 easy after the 200s (think 10k/5k/3k effort on each set) — then 4 × 200 fast/200 easy (push these), 2–3 mi easy cooldown.",
          "Optional uphill TM or x-train double.",
          "Full strength.",
          "First track workout! You can always adjust these sessions to be time-based off-track. Nice and smooth! No need to take splits, run it on feel.",
        ],
      },
      {
        dow: "Thu", type: "easy", title: "8–12 mi easy or 1.5–2.5 hr x-train",
        details: [
          "8–12 mi easy or 1.5–2.5 hours easy/mod x-train.",
          "Optional easy double or uphill TM.",
        ],
      },
      {
        dow: "Fri", type: "easy", title: "6–10 mi easy + 4 × 30 sec hills",
        details: ["6–10 mi easy plus 4 × 30 sec hills.", "Heat ideal."],
      },
      {
        dow: "Sat", type: "long", title: "Long run: 14–18 mi with 1-mi alternations",
        details: [
          "14–18 mi easy/mod (10–12 miles alternating 1 mi at 1-hour effort with 1 mi float recovery). On the 1-hour effort, think smooth and strong, so that you can transition into float recoveries that are a bit faster than normal easy pace.",
        ],
      },
      {
        dow: "Sun", type: "easy", title: "10–16 mi easy and/or longer x-train",
        details: [
          "10–16 mi easy and/or longer x-train.",
          "No strength routine (or very little strength work) to be fresh for next week.",
        ],
      },
    ],
  },
  {
    week: 5,
    days: [
      {
        dow: "Mon", type: "rest", title: "Rest day",
        details: ["Rest. Heat ideal."],
      },
      {
        dow: "Tue", type: "easy", title: "8–12 mi easy + 5 × 20 sec hills",
        details: [
          "8–12 mi easy plus 5 × 20 second hills. Keep this run very easy before the push tomorrow!",
        ],
      },
      {
        dow: "Wed", type: "workout", title: "5k time trial + 2 mi @ M effort",
        details: [
          "3 mi easy warm-up with a couple strides, 5k hard on a slight net downhill ideally (just 50–100 feet, nothing too substantial), 5 min easy, 2 miles at M effort, 1–2 miles very easy.",
          "Optional uphill TM or x-train double.",
          "Full strength routine.",
        ],
      },
      {
        dow: "Thu", type: "easy", title: "8–12 mi easy or 1.5–2.5 hr x-train",
        details: [
          "8–12 mi easy or 1.5–2.5 hours easy/mod x-train.",
          "Optional easy double or uphill TM.",
        ],
      },
      {
        dow: "Fri", type: "easy", title: "6–10 mi easy + 4 × 20 sec hills",
        details: ["6–10 mi easy plus 4 × 20 second hills.", "Heat ideal."],
      },
      {
        dow: "Sat", type: "long", title: "Long run: 18–22 mi easy/mod over hills",
        details: [
          "18–22 mi easy/mod over hills, progressing into a steady effort, with full fueling and hydration.",
        ],
      },
      {
        dow: "Sun", type: "easy", title: "10–16 mi easy and/or longer x-train",
        details: ["10–16 mi easy and/or longer x-train.", "Full strength routine."],
      },
    ],
  },
  {
    week: 6,
    days: [
      {
        dow: "Mon", type: "rest", title: "Rest day",
        details: ["Rest. Heat ideal."],
      },
      {
        dow: "Tue", type: "easy", title: "Down week: 6–10 mi easy + 5 × 20 sec strides",
        details: ["Slight down week! 6–10 mi easy with 5 × 20 seconds fast/2 min easy."],
      },
      {
        dow: "Wed", type: "workout", title: "Threshold: 6–8 × 5 min @ 1-hr effort",
        details: [
          "3 mi easy warm-up with a couple strides, 6–8 × 5 min around 1-hour effort with 90 seconds easy after each, 2–3 mi easy cool-down.",
          "Optional uphill TM or x-train double with 3–4 × 5 min moderate with 2 min easy recovery (double workout option).",
          "Really big threshold workout this week!",
          "Full strength routine.",
        ],
      },
      {
        dow: "Thu", type: "easy", title: "6–10 mi easy or 1.5–2.5 hr x-train",
        details: [
          "6–10 mi easy or 1.5–2.5 hours easy/mod x-train.",
          "Optional easy double or uphill TM.",
        ],
      },
      {
        dow: "Fri", type: "easy", title: "4–8 mi easy + 4 × 20 sec hills",
        details: ["4–8 mi easy plus 4 × 20 sec hills.", "Heat ideal."],
      },
      {
        dow: "Sat", type: "long", title: "Long run: 14–18 mi with 3 × 3 mi tempo",
        details: [
          "14–18 mi easy/mod with 3 × 3 miles broken down as (1 mile at 10k effort into 2 miles at marathon effort) with 1 mile easy recovery after each, with the option to add 1 mile harder at the end for advanced athletes.",
          "The long run with harder-start tempo intervals will help the body improve lactate shuttling and marathon endurance.",
        ],
      },
      {
        dow: "Sun", type: "easy", title: "8–14 mi easy and/or longer x-train",
        details: ["8–14 mi easy and/or longer x-train.", "Full strength routine."],
      },
    ],
  },
  {
    week: 7,
    days: [
      {
        dow: "Mon", type: "rest", title: "Rest day",
        details: ["Rest. Heat ideal."],
      },
      {
        dow: "Tue", type: "easy", title: "8–12 mi easy + 5 × 20 sec strides",
        details: ["8–12 mi easy with 5 × 20 seconds fast/2 min easy."],
      },
      {
        dow: "Wed", type: "workout", title: "10 × 800 + 4 × 200",
        details: [
          "3 mi easy with a couple strides, 10 × 800 fast with 400 easy recovery after each (think 10k effort to start, pushing as you go), 4 × 200 fast/200 slow (push these), 2–3 miles easy.",
          "Optional uphill TM or x-train double.",
          "Full strength routine.",
          "We’ll be revisiting this workout later too!",
        ],
      },
      {
        dow: "Thu", type: "easy", title: "8–14 mi easy or 1.5–2.5 hr x-train",
        details: [
          "8–14 mi easy or 1.5–2.5 hours easy/mod x-train.",
          "Optional easy double or uphill TM.",
        ],
      },
      {
        dow: "Fri", type: "easy", title: "6–10 mi very easy",
        details: ["6–10 mi very easy."],
      },
      {
        dow: "Sat", type: "long", title: "Long run: 20–24 mi with 5/4/3/2/1 @ M effort",
        details: [
          "20–24 mi easy/mod with 5/4/3/2/1 miles at M effort with 1 mile float recovery after each (can push the 2nd half of the 2 and 1 faster). Do everything like race day, and if you’re feeling good you can end this one harder!",
        ],
      },
      {
        dow: "Sun", type: "easy", title: "10–16 mi easy and/or longer x-train",
        details: ["10–16 mi easy and/or longer x-train.", "Full strength routine."],
      },
    ],
  },
  {
    week: 8,
    days: [
      {
        dow: "Mon", type: "rest", title: "Rest day",
        details: ["Rest. Heat ideal."],
      },
      {
        dow: "Tue", type: "easy", title: "8–12 mi easy + 5 × 20 sec hills",
        details: ["8–12 mi easy plus 5 × 20 second hills."],
      },
      {
        dow: "Wed", type: "workout", title: "5–6 × 1 mile @ 10k effort",
        details: [
          "3 mi easy with a couple strides, 5–6 × 1 mile with 2 min easy recovery after each (think 10k effort), 2–3 miles easy.",
          "Optional uphill TM or x-train double with 15 × 1 min moderate with 30 seconds easy recovery (double workout option).",
          "Full strength routine.",
        ],
      },
      {
        dow: "Thu", type: "easy", title: "8–14 mi easy or 1.5–2.5 hr x-train",
        details: [
          "8–14 mi easy or 1.5–2.5 hours easy/mod x-train.",
          "Optional easy double or uphill TM.",
        ],
      },
      {
        dow: "Fri", type: "easy", title: "6–12 mi very easy",
        details: ["6–12 mi very easy."],
      },
      {
        dow: "Sat", type: "long", title: "Long run: 16–20 mi easy over hills",
        details: ["16–20 mi easy over hills, just a nice aerobic long run with big fueling."],
      },
      {
        dow: "Sun", type: "easy", title: "12–18 mi easy + 6 × 30 sec hills and/or x-train",
        details: [
          "12–18 mi easy plus 6 × 30 second hills and/or longer x-train.",
          "No strength or limited strength work to be ready for next week.",
        ],
      },
    ],
  },
  {
    week: 9,
    days: [
      {
        dow: "Mon", type: "rest", title: "Rest day",
        details: ["Rest. Heat ideal."],
      },
      {
        dow: "Tue", type: "easy", title: "8–14 mi very easy + 4 × 20 sec strides",
        details: ["8–14 mi very easy with 4 × 20 seconds fast/2 min easy."],
      },
      {
        dow: "Wed", type: "workout", title: "5 mi tempo + 6 × 45 sec (marathon predictor)",
        details: [
          "3 mi easy with a couple strides, 5 miles hard tempo, 5 min easy, 6 × 45 seconds fast with 75 seconds easy recovery (think 3k effort), 2–3 mi easy cooldown.",
          "Optional uphill TM or x-train double.",
          "Full strength routine.",
          "Use this 5-mile tempo as a guide for marathon pacing, plugging it into a <a href=\"https://lukehumphreyrunning.com/hmmcalculator/race_equivalency_calculator.php\" target=\"_blank\" rel=\"noopener\">race calculator</a> that can help you determine an approximate strategy (adjusting up or down based on your feel in workouts).",
        ],
      },
      {
        dow: "Thu", type: "easy", title: "8–14 mi easy or 1.5–2.5 hr x-train",
        details: [
          "8–14 mi easy or 1.5–2.5 hours easy/mod x-train.",
          "Optional easy double or uphill TM.",
        ],
      },
      {
        dow: "Fri", type: "easy", title: "6–8 mi very easy + 4 × 20 sec strides",
        details: ["6–8 mi very easy with 4 × 20 seconds fast/2 min easy."],
      },
      {
        dow: "Sat", type: "long", title: "Long run: 18–22 mi with 4–5 × 3 mi @ M effort+",
        details: [
          "18–22 mi easy/mod with 4–5 × 3 mi broken down as (2 miles at M effort plus 1 mile faster) with 1 mile float recovery.",
        ],
      },
      {
        dow: "Sun", type: "easy", title: "10–18 mi easy and/or longer x-train",
        details: ["10–18 mi easy and/or longer x-train.", "Full strength routine."],
      },
    ],
  },
  {
    week: 10,
    days: [
      {
        dow: "Mon", type: "rest", title: "Rest day",
        details: ["Rest. Heat ideal."],
      },
      {
        dow: "Tue", type: "easy", title: "8–14 mi easy + 5 × 20 sec hills",
        details: ["8–14 mi easy plus 5 × 20 second hills."],
      },
      {
        dow: "Wed", type: "workout", title: "10 × 800, round two",
        details: [
          "3 mi easy with a couple strides, 10 × 800 fast with 400 easy recovery after each (think 10k effort to start, pushing as you go), 2–3 miles easy.",
          "Optional uphill TM or x-train double.",
          "Full strength routine.",
          "Revisiting this workout one more time, hopefully with some progress! It’s ok if not though — we aren’t training for 800 workouts.",
        ],
      },
      {
        dow: "Thu", type: "easy", title: "8–14 mi easy or 1.5–2.5 hr x-train",
        details: [
          "8–14 mi easy or 1.5–2.5 hours easy/mod x-train.",
          "Optional easy double or uphill TM.",
        ],
      },
      {
        dow: "Fri", type: "easy", title: "6–12 mi very easy",
        details: ["6–12 mi very easy."],
      },
      {
        dow: "Sat", type: "long", title: "Long run: 16–20 mi with 4 × 10 min @ 1-hr effort",
        details: [
          "16–20 mi easy/mod with 4 × 10 min at 1-hour effort with 3 min easy recovery after each. Final big threshold stimulus!",
        ],
      },
      {
        dow: "Sun", type: "easy", title: "10–16 mi easy + 6 × 30 sec hills and/or x-train",
        details: [
          "10–16 mi easy plus 6 × 30 second hills and/or longer x-train.",
          "Full strength routine.",
        ],
      },
    ],
  },
  {
    week: 11,
    days: [
      {
        dow: "Mon", type: "rest", title: "Rest day",
        details: ["Rest. Heat ideal."],
      },
      {
        dow: "Tue", type: "easy", title: "6–10 mi easy + 4 × 20 sec hills",
        details: ["6–10 mi easy plus 4 × 20 second hills."],
      },
      {
        dow: "Wed", type: "workout", title: "Taper workout: 3 min/1 min reps + 2 mi @ M",
        details: [
          "3 mi easy with a couple strides, 3–5 × 3 min fast/1 min easy (think 10k effort), 3 min easy, 3–5 × 1 min fast/1 min easy (think 5k effort), 3 min easy, 2 miles at M effort on tired legs, 2–3 mi easy.",
          "Optional uphill TM or x-train double.",
          "Limited strength work — let the body recover now.",
          "Go on the low end of the range if you feel tired at all!",
        ],
      },
      {
        dow: "Thu", type: "easy", title: "6–10 mi easy or 1–2 hr x-train",
        details: ["6–10 mi easy or 1–2 hours easy/mod x-train.", "No double option."],
      },
      {
        dow: "Fri", type: "easy", title: "4–10 mi easy + 4 × 20 sec strides",
        details: ["4–10 mi easy with 4 × 20 seconds fast/2 min easy."],
      },
      {
        dow: "Sat", type: "long", title: "10–14 mi with 2 × 2 mi @ M effort",
        details: [
          "10–14 mi easy/mod with 2 × 2 mi at M effort with 1 mi float recovery. A nice aerobic session to get the feel for M effort in taper!",
        ],
      },
      {
        dow: "Sun", type: "easy", title: "6–10 mi easy and/or shorter x-train",
        details: [
          "6–10 mi easy and/or shorter x-train.",
          "No strength work outside of mobility/core and other things that make your body feel good!",
        ],
      },
    ],
  },
  {
    week: 12,
    days: [
      {
        dow: "Mon", type: "rest", title: "Rest day",
        details: ["Rest. Heat ideal."],
      },
      {
        dow: "Tue", type: "easy", title: "6–8 mi easy + 4 × 20 sec strides",
        details: ["6–8 mi easy with 4 × 20 seconds fast/2 min easy."],
      },
      {
        dow: "Wed", type: "workout", title: "Race-week tune-up",
        details: [
          "2–3 mi easy, 3 × 5 min around 1-hour effort with 1 min easy recovery, 4 × 45 seconds around 3k effort with 75 seconds easy recovery, 2–3 mi easy. A tune-up session to keep things sharp in the taper!",
          "No strength work this week!",
        ],
      },
      {
        dow: "Thu", type: "easy", title: "4–8 mi easy",
        details: ["4–8 mi easy. Light on feet and relaxed!"],
      },
      {
        dow: "Fri", type: "rest", title: "Rest and recovery",
        details: ["Rest and recovery. Just a nice chill day!"],
      },
      {
        dow: "Sat", type: "easy", title: "3–6 mi easy shakeout + strides",
        details: [
          "3–6 mi easy with 4 × 20 seconds fast/2 min easy (relaxed strides, nothing too fast) and 1 min at 10k effort to open up the aerobic system.",
        ],
      },
      {
        dow: "Sun", type: "race", title: "MARATHON! 🏁",
        details: [
          "Marathon! Use the predictor workout to give you a feel for what pace to start at. Fuel with 75–90 g of carbs per hour, hydrate with 16–24 oz fluid per hour with electrolytes according to your sweat rate, and BELIEVE. You got this!",
        ],
      },
    ],
  },
];

// Flat list of all 84 days: index 0 = Week 1 Monday, index 83 = race day.
const PLAN_DAYS = PLAN_WEEKS.flatMap((w) =>
  w.days.map((d) => ({ week: w.week, ...d }))
);

const TOTAL_DAYS = PLAN_DAYS.length; // 84
const RACE_DAY_INDEX = TOTAL_DAYS - 1; // 83

// Allow use from Node for sanity tests.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { PLAN_WEEKS, PLAN_DAYS, TOTAL_DAYS, RACE_DAY_INDEX };
}
