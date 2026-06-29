// scripts/app-map/manifest.mjs
// Curated, plain-language decomposition tree. This is the human source of truth
// for MEANING. The build step joins `code` hints to mechanically-extracted facts
// and flags anything documented here but missing in code (stale) or present in
// code but claimed by no node (undocumented).

export const manifest = {
  id: 'root',
  label: 'Apex Health OS — your personal health & performance coach',
  description:
    'An app that gathers everything about your training, sleep, recovery, body and food into one place, then gives you a coaching team that tells you what to do each day.',
  children: [
    {
      id: 'team',
      label: 'Your coaching team',
      description:
        'Four coaches share one chat. You talk to all of them; your question is quietly handed to whichever one it belongs to.',
      children: [
        {
          id: 'coach-peter',
          label: 'Peter — your head coach',
          description:
            'The coach in charge. He sees the big picture, settles anything that spans several areas, sets your multi-week training blocks, and writes your morning summary and weekly review.',
          code: { coaches: ['peter'] },
        },
        {
          id: 'coach-carter',
          label: 'Carter — strength & conditioning',
          description:
            'Handles your workouts: which exercises, how heavy, how many sets, when to push and when to back off, plus your cardio/endurance sessions.',
          code: { coaches: ['carter'] },
        },
        {
          id: 'coach-nora',
          label: 'Nora — nutrition',
          description:
            'Handles food: how much to eat, your protein and macro targets, hydration, and your weight-loss-medication phase. You can log meals by chatting with her.',
          code: { coaches: ['nora'] },
        },
        {
          id: 'coach-remi',
          label: 'Remi — recovery & sleep',
          description:
            'Watches how rested you are: heart-rate variability versus your normal, sleep quality, training stress versus recovery, and early warning signs of illness.',
          code: { coaches: ['remi'] },
        },
      ],
    },
    {
      id: 'inputs',
      label: 'What you put in',
      description: 'Where the app gets its information — partly from your devices, partly from you.',
      children: [
        {
          id: 'inputs-devices',
          label: 'Your devices & apps',
          description:
            'Automatic feeds: your WHOOP strap (recovery, sleep, strain), your Withings scale (weight and body composition), Strava (rides, runs, swims), Apple Health via your Garmin watch (steps, calories, distance).',
        },
        {
          id: 'inputs-you',
          label: 'Things you tell it',
          description:
            'What you enter yourself: your morning check-in (how you feel, soreness, illness), meals you log, workouts you log, monthly body measurements, your goals and profile, and anything you say in chat.',
        },
      ],
    },
    {
      id: 'features',
      label: 'What it does for you',
      description: 'The coaching things the app produces from all that information.',
      children: [
        { id: 'feat-brief', label: 'Morning brief', description: 'A short daily card: yesterday recap, how ready you are today, today’s session or rest, your food targets, a coaching tip, and tonight’s sleep goal.' },
        { id: 'feat-weekly-review', label: 'Weekly review', description: 'A Sunday recap of the week and a plan for the next one, which you confirm.' },
        { id: 'feat-weekly-plan', label: 'Weekly plan', description: 'Your committed training week — which session falls on which day, with the right weights worked out for you.' },
        { id: 'feat-dashboard', label: 'Daily dashboard', description: 'Peter’s once-a-day read of how your goals, energy, fatigue and progress fit together.' },
        { id: 'feat-trends', label: 'Trends', description: 'Longer-term patterns in strength, body composition, nutrition and recovery.' },
        { id: 'feat-nudges', label: 'Nudges', description: 'The coach reaching out on its own when something needs attention — a stall, falling behind a target, or recovery dropping.' },
        { id: 'feat-food-log', label: 'Food logging', description: 'Log meals by typing, scanning a barcode, or chatting with Nora; she works out the calories and macros.' },
        { id: 'feat-workout-log', label: 'Workout logging', description: 'Log lifts set by set in the app, with a rest timer and voice entry, instead of a separate app.' },
        { id: 'feat-endurance', label: 'Endurance training', description: 'Cardio training built around heart-rate zones and training load, fed by Strava.' },
        { id: 'feat-glp1', label: 'Medication-aware nutrition', description: 'Nutrition that adjusts while you’re on weight-loss medication — higher protein, no diet breaks — and switches back afterward.' },
      ],
    },
    {
      id: 'screens',
      label: 'Where you go',
      description: 'The screens in the app and what each one is for.',
      children: [
        { id: 'screen-home', label: 'Home', description: 'Your daily readiness view at a glance.', code: { routes: ['/'] } },
        { id: 'screen-diet', label: 'Meals', description: 'Your food journal, meal by meal.', code: { routes: ['/diet'] } },
        { id: 'screen-health', label: 'Metrics & log', description: 'Your numbers — recovery, sleep, body — and the place to enter or correct them by hand.', code: { routes: ['/health'] } },
        { id: 'screen-coach', label: 'Coach', description: 'Chat with the coaching team and see Peter’s dashboard.', code: { routes: ['/coach'] }, children: [
          { id: 'screen-coach-reviews', label: 'Past weekly reviews', description: 'A list of your previous Sunday recaps, so you can look back at any week.', code: { routes: ['/coach/reviews'] } },
          { id: 'screen-coach-week', label: 'A week in detail', description: 'The full write-up for one week — what you did, how it went, and the plan that came out of it.', code: { routes: ['/coach/weeks/:week_start'] } },
          { id: 'screen-coach-session', label: 'A workout in detail', description: 'Everything about one logged training session — the exercises, sets, and weights.', code: { routes: ['/coach/sessions/:workout_id'] } },
        ] },
        { id: 'screen-strength', label: 'Strength', description: 'Today’s session and your lifting plan.', code: { routes: ['/strength'] } },
        { id: 'screen-profile', label: 'Profile', description: 'Your goals, settings, device connections and food library.', code: { routes: ['/profile'] }, children: [
          { id: 'screen-profile-prompts', label: 'How your coaches talk', description: 'A place to tweak the style and tone your coaching team uses when they message you.', code: { routes: ['/profile/coach-prompts'] } },
          { id: 'screen-profile-library', label: 'Your food library', description: 'Your saved foods and recipes, so logging the meals you eat often is one tap.', code: { routes: ['/profile/library'] } },
        ] },
        { id: 'screen-onboarding', label: 'Onboarding', description: 'The first-time setup that captures your history and goals.', code: { routes: ['/onboarding'] } },
      ],
    },
    {
      id: 'how-it-decides',
      label: 'How it decides',
      description: 'The thinking behind the advice, in plain terms.',
      children: [
        { id: 'decide-readiness', label: 'Readiness score', description: 'Combines recovery, sleep and strain into a single "how ready are you today" band that shapes the day’s plan.' },
        { id: 'decide-prescription', label: 'How weights are chosen', description: 'A fixed set of rules — not guesswork by the coach — picks each session’s weights from your recent lifts and where you are in the block.' },
        { id: 'decide-today', label: 'What counts as "today"', description: 'Everything is anchored to your timezone, so a workout at midnight lands on the right day.' },
        { id: 'decide-ownership', label: 'Which source wins', description: 'When two devices report the same thing, the more accurate one wins — e.g. steps come from your watch, not your scale.' },
      ],
    },
    {
      id: 'under-the-hood',
      label: 'Under the hood (for the curious)',
      description: 'The technical map: every screen, behind-the-scenes endpoint, coach tool and database change. You can ignore this branch entirely.',
      code: { migrations: 'all' },
      children: [
        { id: 'uth-routes', label: 'All screens (routes)', description: 'Every page the app serves.', code: { routes: '*' } },
        { id: 'uth-api', label: 'Behind-the-scenes endpoints', description: 'The server endpoints that sync devices, run the coaches and save your data.', code: { apiRoutes: '*' } },
        { id: 'uth-tools', label: 'Coach tools', description: 'The specific actions each coach is allowed to take.', code: { tools: '*' } },
        { id: 'uth-migrations', label: 'Database history', description: 'Every change made to the database structure over time.', code: { migrations: 'all' } },
      ],
    },
  ],
};

// Page routes that legitimately have no plain-language screen node (non-content/utility pages).
// Any page route NOT narrated by a screens-branch node and NOT listed here is reported as
// "needs a plain-language description" by the drift check.
export const screensExempt = ['/login', '/privacy'];
