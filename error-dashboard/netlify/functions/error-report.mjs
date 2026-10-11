import { getStore } from '@netlify/blobs'
import { createHandler } from '../lib/report-handler.mjs'
export default createHandler(() => getStore({ name: 'jarvis-error-reports', consistency: 'strong' }))
