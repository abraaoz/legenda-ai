// O Electrobun expõe seus módulos como fonte .ts (via package "exports"), então
// o tsc acaba checando o código interno dele — que importa libs 3D opcionais
// (WebGPU) sem tipos. Estes shims silenciam esse ruído; não usamos essas libs.
declare module 'three'
declare module 'babylonjs'
declare module '@babylonjs/core'
