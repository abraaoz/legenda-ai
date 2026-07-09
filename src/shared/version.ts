// Fonte ÚNICA da versão do app: o campo "version" do package.json.
// Todos os outros módulos importam daqui — nunca hardcodam a versão.
import { version } from '../../package.json'

export { version }
