import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { startOfDay, toIsoDay } from '../utils/dateHelpers';

/**
 * Live "today" (local start-of-day) that stays correct across an overnight
 * background-resume.
 *
 * iOS keeps the JS process alive when the app is backgrounded, so a
 * `useMemo(() => startOfDay(new Date()), [])` freezes "today" at whenever
 * the component first mounted — after resuming the next morning without a
 * cold launch the app still thinks it's yesterday (audit H-1: the header,
 * WeekBar, and the date written to BQE all go a day stale).
 *
 * This hook recomputes on every AppState 'active' transition and swaps in a
 * new Date ONLY when the calendar day actually changed. Same-day resumes
 * compare equal on the day key and skip setState, so rapid
 * foreground/background toggles (Control Center, notification banners) don't
 * thrash renders. Fresh at every mount via the useState initializer.
 *
 * Reuses the existing timezone-safe helpers (startOfDay / toIsoDay) — no new
 * date-parsing path.
 */
export function useToday(): Date {
  const [today, setToday] = useState(() => startOfDay(new Date()));
  const dayKeyRef = useRef(toIsoDay(today));

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const now = startOfDay(new Date());
      const key = toIsoDay(now);
      if (key !== dayKeyRef.current) {
        dayKeyRef.current = key;
        setToday(now);
      }
    });
    return () => sub.remove();
  }, []);

  return today;
}
