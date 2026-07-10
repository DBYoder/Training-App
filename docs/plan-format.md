# Training plan formats

The app accepts two upload formats. Either way, a plan is a grid of weeks ×
days; when you schedule it, the app lays those days onto the calendar — either
ending on your goal race date or starting on a date you pick.

## 1. Markdown table

One row per week, one column per day. This is the format of the built-in SWAP
plan (`plans/swap-12-week-marathon.md` in this repo is a full example):

```markdown
**My 10-Week Plan**

|        | Mon  | Tue          | Wed                             | Thu       | Fri  | Sat               | Sun       |
| ------ | ---- | ------------ | ------------------------------- | --------- | ---- | ----------------- | --------- |
| Week 1 | Rest | 5 mi easy    | 6 x 800 at 10k effort, 2mi easy | 4 mi easy | Rest | Long run: 10 mi   | 4 mi easy |
| Week 2 | Rest | 5 mi easy    | 3 mi tempo, 2 mi easy           | 4 mi easy | Rest | Long run: 12 mi   | 4 mi easy |
```

- The first non-table line becomes the plan's name.
- The first header column is ignored; the rest become day labels (any number
  of days per week from 2–14, not just 7).
- Markdown links `[text](https://…)` are kept as clickable links.
- Day types are detected automatically from the text: **rest**, **easy**,
  **workout** (tempo/intervals/reps), **long run** (leading mileage ≥ 12 or
  "long run"), and **race** (last day mentioning a race, or "race day").

## 2. JSON

The explicit format — use it when you want full control over types and titles:

```json
{
  "name": "My 10-Week Plan",
  "dayHeaders": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  "weeks": [
    {
      "days": [
        { "type": "rest",    "title": "Rest day",       "details": ["Full rest."] },
        { "type": "easy",    "title": "5 mi easy",      "details": ["5 mi conversational."] },
        { "type": "workout", "title": "6 x 800",        "details": ["2 mi warm-up.", "6 x 800 at 10k effort, 400 jog."] },
        { "type": "easy",    "title": "4 mi easy",      "details": ["Relaxed."] },
        { "type": "rest",    "title": "Rest day",       "details": ["Full rest."] },
        { "type": "long",    "title": "Long run 10 mi", "details": ["Easy effort, fuel well."] },
        { "type": "easy",    "title": "4 mi easy",      "details": ["Shakeout."] }
      ]
    }
  ]
}
```

- `type` must be one of `rest`, `easy`, `workout`, `long`, `race` — omit it to
  let the app classify the day from its text.
- `details` is a list of paragraphs (plain text; `[text](https://…)` links are
  allowed). `dayHeaders` is optional (defaults to Mon–Sun).
- Every week must have the same number of days (1–14); up to 60 weeks.
