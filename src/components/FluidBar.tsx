import type { Computed, FluidUI, ProjectUI } from '../model';
import { FLUID_LIBRARY, fluidInfo } from '../solver';
import { useUnits } from '../units';
import { NumField } from './NumField';

interface Props {
  project: ProjectUI;
  computed: Computed;
  onFluid: (patch: Partial<FluidUI>) => void;
  /** Change a top-level project setting; `key` merges rapid edits of the same field into one undo step. */
  onSetting: (patch: Partial<ProjectUI>, key: string) => void;
}

/** Fluid, temperature and design limits, with the fluid's properties at the working temperature. */
export function FluidBar({ project, computed, onFluid, onSetting }: Props) {
  const units = useUnits();
  const info = fluidInfo(project.fluid.id);
  const custom = project.fluid.id === 'custom';
  return (
    <div className="header-fluid fluidbar">
      <label className="field wide">
        <span>Fluid</span>
        <select value={project.fluid.id} onChange={(e) => onFluid({ id: e.target.value as FluidUI['id'] })}>
          {FLUID_LIBRARY.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </label>
      {custom ? (
        <>
          <label className="field">
            <span>Name</span>
            <input value={project.fluid.customName} onChange={(e) => onFluid({ customName: e.target.value })} />
          </label>
          <NumField label="Density" q="density" value={project.fluid.customDensity} onChange={(v) => onFluid({ customDensity: v })} />
          <NumField label="Viscosity" q="viscosity" value={project.fluid.customViscosityMPas} onChange={(v) => onFluid({ customViscosityMPas: v })} />
          <NumField label="Vapour pressure (abs)" q="pressure" value={project.fluid.customVaporKPa} onChange={(v) => onFluid({ customVaporKPa: v })} />
        </>
      ) : (
        <NumField label="Temperature" q="temperature" value={project.temperatureC} onChange={(v) => onSetting({ temperatureC: v }, 'temp')} title={`${units.f('temperature', info.tMinC, 0)} to ${units.fu('temperature', info.tMaxC, 0)}`} />
      )}
      <label className="field"><span>Friction</span>
        <select aria-label="Friction method" value={project.frictionMethod ?? 'dw'} onChange={(e) => onSetting({ frictionMethod: e.target.value === 'hw' ? 'hw' : undefined }, 'friction')}>
          <option value="dw">Darcy–Weisbach</option>
          <option value="hw">Hazen–Williams</option>
        </select>
      </label>
      <NumField label="NPSH margin" q="head" value={project.npshMarginM} onChange={(v) => onSetting({ npshMarginM: v }, 'npsh')} />
      <NumField label="Max velocity" q="velocity" value={project.maxVelocityMps} onChange={(v) => onSetting({ maxVelocityMps: v }, 'vmax')} title="0 = off" />
      {computed.model && (
        <span className="fluid-props">
          ρ {units.fu('density', computed.model.fluid.density, 1)} · μ {units.fu('viscosity', computed.model.fluid.dynamicViscosity * 1000, 3)} · p<sub>v</sub> {units.fu('pressure', computed.model.fluid.vaporPressure / 1000, 2)}
        </span>
      )}
    </div>
  );
}
