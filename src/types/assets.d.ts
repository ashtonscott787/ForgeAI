/** Vite turns an imported image into a URL string at build time. */
declare module "*.webp" {
  const url: string;
  export default url;
}
declare module "*.png" {
  const url: string;
  export default url;
}
