import { ObjectId } from "mongodb";

export function getUserIds(userId) {
  const stringId = String(userId);
  const ids = [stringId];
  if (/^[a-f\d]{24}$/i.test(stringId)) {
    ids.push(new ObjectId(stringId));
  }
  return ids;
}

export function getObjectIdAndStringIds(id) {
  const stringId = String(id);
  const ids = [stringId];
  if (/^[a-f\d]{24}$/i.test(stringId)) {
    ids.push(new ObjectId(stringId));
  }
  return ids;
}
