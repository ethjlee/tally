import { consecutiveHabitDays, pauseOn, statsStartKey, todayKey } from "./days.js";
import { taskActivity } from "./tasks.js";
import { ledgerState } from "../state.js";

export function recomputeHabitStreak(habit){
  const sameNameGoodHabits = ledgerState.habits.filter(h => h.type === 'good' && h.name === habit.name);
  const start = statsStartKey();
  const end = todayKey();
  const dates = new Set(
    ledgerState.entries
      .filter(e => e.type === 'good' && e.date >= start && e.date <= end && !pauseOn(e.date) && (
        e.habitId
          ? e.habitId === habit.id
          : (sameNameGoodHabits.length === 1 && e.name === habit.name)
      ))
      .map(e => e.date)
  );
  assignHabitStreak(habit, dates);
}

function assignHabitStreak(habit, dates){
  let lastDate = null;
  for(const date of dates || []){
    if(lastDate === null || date > lastDate) lastDate = date;
  }
  habit.lastDate = lastDate;
  habit.streak = consecutiveHabitDays(dates, lastDate);
}

export function recomputeAllHabitStreaks(){
  if(!ledgerState.habits.length) return;
  const { creditDates } = taskActivity('habit', todayKey());
  ledgerState.habits.forEach(habit => assignHabitStreak(habit, creditDates.get(habit.id)));
}
