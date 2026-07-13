import { makeSmartBuildRequest } from '../services/smartbuildService.js';
import { listMappers, getMappings } from '../services/mapperService.js';
import { syncLocation } from '../services/qbSyncService.js';
import { createError } from '../core/middleware/errorHandler.js';

/**
 * Retrieve a SmartBuild job by jobId.
 * Expected body: { jobId }
 */
export async function retrieveSmartBuildJob(req, res, next) {
  try {
    const { locationId } = req.user;
    const { jobId } = req.body;

    if (!jobId) throw createError(400, 'jobId is required');

    const jobData = await makeSmartBuildRequest(locationId, 'GET', '/GetJobData', {
      query: { jobId },
    });

    res.json({ success: true, jobData });
  } catch (err) {
    next(err);
  }
}

/**
 * Create or edit a SmartBuild job.
 * Expected body: { jobId? (omit to create new), jobDataModel }
 * jobDataModel shape: { model: cannedModel, answers: userAnswer2[] }
 */
export async function createOrEditSmartBuildJob(req, res, next) {
  try {
    const { locationId } = req.user;
    const { jobId, jobDataModel } = req.body;

    if (!jobDataModel) throw createError(400, 'jobDataModel is required');

    const result = await makeSmartBuildRequest(locationId, 'POST', '/SetJobDataModel', {
      query: jobId ? { jobId } : undefined,
      body: jobDataModel,
    });

    res.json({ success: true, jobId: result });
  } catch (err) {
    next(err);
  }
}

export async function updateOpportunity(req, res) {
  res.json({ success: true, message: 'update-opportunity received' });
}

/**
 * POST /actions/quickbooks-sync
 * Manually trigger a two-way QuickBooks sync pass for the caller's location.
 */
export async function triggerQuickBooksSync(req, res, next) {
  try {
    const { locationId } = req.user;
    const stats = await syncLocation(locationId);
    res.json({ success: true, stats });
  } catch (err) {
    next(err);
  }
}

/**
 * Return mappers for the authenticated location.
 * Query params: appSlug?, mapperType?, format? ('map' → externalKey→ghlValue lookup)
 */
export async function getMappers(req, res, next) {
  try {
    const { locationId } = req.user;
    const { appSlug, mapperType, format } = req.query;

    if (format === 'map') {
      const mappings = await getMappings(locationId, appSlug, mapperType);
      return res.json({ success: true, mappings });
    }

    const rows = await listMappers(locationId, appSlug, mapperType);
    res.json({ success: true, mappers: rows });
  } catch (err) {
    next(err);
  }
}
