import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.weekly(
  "memory-forgetting-cycle",
  {
    dayOfWeek: "sunday",
    hourUTC: 5,
    minuteUTC: 0,
  },
  internal.memories.runWeeklyMaintenance,
  {}
);

export default crons;
