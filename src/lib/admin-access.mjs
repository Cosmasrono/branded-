// Server-side only: derive access from configuration without persisting extra roles.
export function withAdminAccess(user) {
  const email = String(user.email || "").trim().toLowerCase();
  const adminEmails = String(process.env.adminEmail || "")
    .split(/[,;\s]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (!email || !adminEmails.includes(email)) return user;
  const roles = user.roles || [];
  if (roles.some((role) => role.name === "super_admin")) return user;
  return {
    ...user,
    roles: [...roles, { name: "super_admin", permissions: [] }],
  };
}
