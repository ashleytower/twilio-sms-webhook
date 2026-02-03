import { createLogger } from '../utils/logger.js';

const logger = createLogger('calendar');

const RUBE_API_URL = process.env.RUBE_API_URL;
const RUBE_API_KEY = process.env.RUBE_API_KEY;

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
 * Get events for a specific date via Rube/Google Calendar
 */
async function getEventsForDate(date) {
  if (!RUBE_API_URL || !RUBE_API_KEY) {
    logger.warn('Rube not configured, skipping calendar');
    return [];
  }

  // Create date range for the day
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  try {
    const response = await fetch(`${RUBE_API_URL}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RUBE_API_KEY}`
      },
      body: JSON.stringify({
        tool: 'GOOGLE_CALENDAR_LIST_EVENTS',
        params: {
          time_min: startOfDay.toISOString(),
          time_max: endOfDay.toISOString(),
          max_results: 20
        }
      })
    });

    const data = await response.json();
    return data.events || [];
  } catch (error) {
    logger.error({ error }, 'Google Calendar API failed');
    return [];
  }
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
