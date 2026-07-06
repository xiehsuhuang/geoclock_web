export type FamilyPermissions = {
  can_view_status: boolean;
  can_view_approx_location: boolean;
  can_view_precise_location: boolean;
  can_receive_notifications: boolean;
  can_wake_me: boolean;
  can_view_destination: boolean;
};

export const DEFAULT_FAMILY_PERMISSIONS: FamilyPermissions = {
  can_view_status: true,
  can_view_approx_location: true,
  can_view_precise_location: false,
  can_receive_notifications: true,
  can_wake_me: true,
  can_view_destination: true
};

export function normalizePermissions(input: Partial<FamilyPermissions> | undefined): FamilyPermissions {
  return {
    ...DEFAULT_FAMILY_PERMISSIONS,
    ...(input ?? {})
  };
}

export function getFamilyPair(codeA: string, codeB: string) {
  const [userA, userB] = [codeA.trim().toUpperCase(), codeB.trim().toUpperCase()].sort();
  return {
    pairKey: `${userA}__${userB}`,
    userA,
    userB
  };
}
