import { makeSmartBuildRequest } from '../services/smartbuildService.js';
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

export async function getMappers(req, res) {
  res.json({ success: true, message: 'get-mappers received' });
}
