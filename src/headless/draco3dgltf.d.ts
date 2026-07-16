declare module 'draco3dgltf' {
  const draco3d: {
    createEncoderModule(): Promise<object>
    createDecoderModule(): Promise<object>
  }
  export default draco3d
}
