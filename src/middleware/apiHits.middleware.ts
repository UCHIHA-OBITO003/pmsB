import type { NextFunction, Request, Response } from 'express';
import { incrementApiHits } from '../utils/api-request-metrics';

/** Place after `/api/` rate limiting so counted traffic matches what can hit handlers. */
export function countApiHits(req: Request, _res: Response, next: NextFunction) {
  if (req.method !== 'OPTIONS') incrementApiHits();
  next();
}
