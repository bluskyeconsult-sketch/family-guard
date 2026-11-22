import { admin } from './supabase';

// Reads a family feature switch. Default on: if there is no row, or the
// check itself fails, the extra is treated as on (the parent turns it off
// explicitly). Mirrors the guard_feature_on function in migration 105.
export async function featureOn(familyId: string, feature: string): Promise<boolean> {
  const { data, error } = await admin().rpc('guard_feature_on', {
    p_family_id: familyId,
    p_feature: feature,
  });
  if (error) return true;
  return data === true;
}
