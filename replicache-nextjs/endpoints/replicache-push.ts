import type { NextApiRequest, NextApiResponse } from "next";
import { push } from "../backend/push";

export async function handlePush(req: NextApiRequest, res: NextApiResponse) {
  const spaceID = req.query["spaceID"].toString();
  await push(spaceID, req.body);
  res.status(200).json({});
}
