import { RootChat as BaseRoot } from "./root";
import { mockModels } from "./mock-model";
export { worker as default } from "./worker";

export class RootChat extends BaseRoot {
  protected createModels() {
    return mockModels();
  }
  protected configured() {
    return true;
  }
}
