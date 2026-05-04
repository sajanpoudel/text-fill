import type { PlatformExtractor } from "./base.ts";
import {
  discordExtractor,
  facebookExtractor,
  gmailExtractor,
  instagramExtractor,
  messengerExtractor,
  outlookExtractor,
  redditExtractor,
  slackExtractor,
  threadsExtractor,
  twitterExtractor,
  youtubeExtractor,
} from "./conversation.ts";
import { linkedInExtractor } from "./linkedin.ts";
import {
  greenhouseExtractor,
  ashbyExtractor,
  workdayExtractor,
  leverExtractor,
} from "./jobboard.ts";

const REGISTRY: PlatformExtractor[] = [
  linkedInExtractor,
  messengerExtractor,
  facebookExtractor,
  instagramExtractor,
  threadsExtractor,
  twitterExtractor,
  redditExtractor,
  youtubeExtractor,
  slackExtractor,
  discordExtractor,
  gmailExtractor,
  outlookExtractor,
  greenhouseExtractor,
  ashbyExtractor,
  workdayExtractor,
  leverExtractor,
];

export function getPlatformExtractor(key: string): PlatformExtractor | null {
  return REGISTRY.find((e) => e.key === key) ?? null;
}
