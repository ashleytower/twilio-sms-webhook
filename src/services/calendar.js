import { createLogger } from '../utils/logger.js';

const logger = createLogger('calendar');

const COMPOSIO_API_URL = 'https://backend.composio.dev/api/v2';
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || process.env.RUBE_API_KEY;
const COMPOSIO_CALENDAR_ACCOUNT_ID = process.env.COMPOSIO_CALENDAR_ACCOUNT_ID;

const CALENDAR_IDS = [
  'ash.cocktails@gmail.com',
  '866fb488b774383512064a7c7a9404c07c59e94bba90621bf64e8da0fd67a3f7@group.calendar.google.com',
  'f7ea264384d41207c299be419cc98efcaaa1ec6ccfa10854e2f4446d9f417e29@group.calendar.google.com',
  'c_749cd4153a2f84021fb73f9b12b43d6643e265a6577d9e79451c0df584f3b138@group.calendar.google.com',
];

/**
 * Get calendar context for a date mentioned in a message
 */
export async function getCalendarContext(messageBody) {
  // Extract date references from message
  const dateRef = extractDateReference(messageBody);
  if (!dateRef) {
    return null;
  }

  try {
    // Get events for the referenced date
    const events = await getEventsForDate(dateRef);
    if (!events || events.length === 0) {
      return `${formatDateForDisplay(dateRef)}: No events scheduled`;
    }

    // Format calendar context
    const context = formatCalendarContext(dateRef, events);
    logger.info({ date: dateRef, eventCount: events.length }, 'Got calendar context');
    return context;
  } catch (error) {
    logger.error({ error }, 'Failed to get calendar context');
    return null;
  }
}

/**
 * Extract date reference from message text
 */
function extractDateReference(text) {
  const lower = text.toLowerCase();

  // Specific date patterns: "June 15", "June 15th", "15 June", "6/15"
  const monthNames = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
  ];

  // Pattern: Month Day
  const monthDayPattern = new RegExp(
    `(${monthNames.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?`,
    'i'
  );
  const monthDayMatch = text.match(monthDayPattern);
  if (monthDayMatch) {
    const monthIndex = monthNames.indexOf(monthDayMatch[1].toLowerCase());
    const day = parseInt(monthDayMatch[2], 10);
    const year = new Date().getFullYear();
    return new Date(year, monthIndex, day);
  }

  // Pattern: MM/DD or M/D
  const slashPattern = /(\d{1,2})\/(\d{1,2})/;
  const slashMatch = text.match(slashPattern);
  if (slashMatch) {
    const month = parseInt(slashMatch[1], 10) - 1;
    const day = parseInt(slashMatch[2], 10);
    const year = new Date().getFullYear();
    return new Date(year, month, day);
  }

  // Relative dates
  const today = new Date();
  if (lower.includes('today')) {
    return today;
  }
  if (lower.includes('tomorrow')) {
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    return tomorrow;
  }
  if (lower.includes('this weekend') || lower.includes('next saturday')) {
    const daysUntilSat = (6 - today.getDay() + 7) % 7 || 7;
    const saturday = new Date(today);
    saturday.setDate(today.getDate() + daysUntilSat);
    return saturday;
  }
  if (lower.includes('next sunday')) {
    const daysUntilSun = (7 - today.getDay()) % 7 || 7;
    const sunday = new Date(today);
    sunday.setDate(today.getDate() + daysUntilSun);
    return sunday;
  }

  return null;
}

/**
 * Get events for a specific date via Composio REST API (Google Calendar)
 * Queries multiple calendars in parallel for a unified view.
 */
async function getEventsForDate(date) {
  if (!COMPOSIO_API_KEY || !COMPOSIO_CALENDAR_ACCOUNT_ID) {
    logger.warn('Composio not configured, skipping calendar');
    return [];
  }

  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const timeMin = toRFC3339(startOfDay);
  const timeMax = toRFC3339(endOfDay);

  try {
    const results = await Promise.allSettled(
      CALENDAR_IDS.map(calId =>
        fetch(`${COMPOSIO_API_URL}/actions/GOOGLECALENDAR_EVENTS_LIST/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': COMPOSIO_API_KEY
          },
          body: JSON.stringify({
            connectedAccountId: COMPOSIO_CALENDAR_ACCOUNT_ID,
            input: { calendarId: calId, timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 20 }
          })
        }).then(r => r.json())
      )
    );

    const seen = new Set();
    const events = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const items = r.value?.data?.items || [];
      for (const e of items) {
        const eid = e.id || `${e.summary}-${e.start?.dateTime || e.start?.date}`;
        if (!seen.has(eid)) {
          seen.add(eid);
          events.push(e);
        }
      }
    }

    events.sort((a, b) => {
      const aTime = new Date(a.start?.dateTime || a.start?.date || 0);
      const bTime = new Date(b.start?.dateTime || b.start?.date || 0);
      return aTime - bTime;
    });

    return events;
  } catch (error) {
    logger.error({ error }, 'Google Calendar API failed');
    return [];
  }
}

function toRFC3339(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  return date.toISOString().replace('Z', '') + sign + hours + ':' + minutes;
}

/**
 * Format calendar context for display
 */
function formatCalendarContext(date, events) {
  const dateStr = formatDateForDisplay(date);

  // Categorize events
  const bookings = [];
  const leads = [];
  const other = [];

  for (const event of events) {
    const title = event.summary || '';
    const lowerTitle = title.toLowerCase();

    if (lowerTitle.includes('lead') || lowerTitle.includes('pending')) {
      leads.push(event);
    } else if (
      lowerTitle.includes('wedding') ||
      lowerTitle.includes('event') ||
      lowerTitle.includes('party') ||
      lowerTitle.includes('booking')
    ) {
      bookings.push(event);
    } else {
      other.push(event);
    }
  }

  let context = `${dateStr}:\n`;

  if (leads.length > 0) {
    context += `- ${leads.length} lead${leads.length > 1 ? 's' : ''} (pending)\n`;
  }

  if (bookings.length > 0) {
    for (const b of bookings) {
      const time = formatEventTime(b);
      context += `- Booking: ${b.summary}${time ? ` (${time})` : ''}\n`;
    }
  }

  if (other.length > 0 && bookings.length === 0 && leads.length === 0) {
    context += `- ${other.length} other event${other.length > 1 ? 's' : ''}\n`;
  }

  if (bookings.length === 0 && leads.length === 0 && other.length === 0) {
    context += '- No events scheduled\n';
  }

  return context.trim();
}

/**
 * Format date for display
 */
function formatDateForDisplay(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });
}

/**
 * Format event time range
 */
function formatEventTime(event) {
  if (!event.start) return null;

  const start = new Date(event.start.dateTime || event.start.date);
  const end = event.end ? new Date(event.end.dateTime || event.end.date) : null;

  const startStr = start.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  if (!end) return startStr;

  const endStr = end.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  return `${startStr}-${endStr}`;
}
