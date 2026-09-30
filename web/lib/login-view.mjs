// The login form (app/login/page.jsx) and its route (app/api/auth/login/route.js).

const LOGIN_ERRORS = Object.freeze({
  1: "Nama pengguna atau kata sandi salah.",
  limit: "Terlalu banyak percobaan. Tunggu beberapa menit, lalu coba lagi.",
});

/** The message for the route's ?error= code, or null for none or an unknown code. */
export function loginErrorMessage(code) {
  return typeof code === "string" && Object.hasOwn(LOGIN_ERRORS, code) ? LOGIN_ERRORS[code] : null;
}

/** Where to go after logging in: a same-site path, else the dashboard. */
export function safeNextPath(value) {
  return typeof value === "string"
    && value.startsWith("/")
    && !value.startsWith("//")
    && !value.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : "/dashboard";
}
