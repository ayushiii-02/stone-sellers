import { OrbitControls } from "@react-three/drei";
import ModelViewer from "./DestroyClock";

export const Experience = () => {
  return (
    <>
      <OrbitControls enableZoom={false} />
      <ModelViewer />
    </>
  );
};