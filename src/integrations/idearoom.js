// IdeaRoom lead capture — inbound push into GHL:
//   configurator 'created'/'updated' event → GHL contact (+ opportunity on create).
// Importing this module registers the webhook handlers.

import { registerIdearoomHandler } from '../core/webhooks/idearoomDispatcher.js';
import { handleIdearoomLead } from '../services/idearoomService.js';

// 'created' = new save/quote/checkout; 'updated' = re-submit of an existing design.
registerIdearoomHandler('created', handleIdearoomLead);
registerIdearoomHandler('updated', handleIdearoomLead);

console.log('[idearoom] IdeaRoom lead-capture integration registered');
