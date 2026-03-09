import { Canvas } from "@react-three/fiber";
import { Experience } from "./components/Experience";
// import { ScrollControls } from "@react-three/drei";

function App() {
  return (
    <Canvas
 dpr={[1,1.5]}
 shadows
 camera={{ position:[0,0,5], fov:30 }}
 gl={{ powerPreference:"high-performance" }}
>
      <color attach="background" args={["#fff"]} />
      {/* <ScrollControls pages={4}> */}
        <Experience />
      {/* </ScrollControls> */}
    </Canvas>
  );
}

export default App;
