import { ObjectId } from "mongodb";

export function getVendorIds(userId) {
  const stringId = String(userId);
  const ids = [stringId];
  if (/^[a-f\d]{24}$/i.test(stringId)) {
    ids.push(new ObjectId(stringId));
  }
  return ids;
}
