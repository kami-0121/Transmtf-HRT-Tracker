import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../contexts/AppDataContext';
import LabView from '../views/LabView';

const LabPage: React.FC = () => {
    const navigate = useNavigate();
    const {
        labResults,
        personalModel,
        lastDiagnostics,
        applyE2LearningToCPA,
        setApplyE2LearningToCPA,
        applyCPAInhibitionToE2,
        setApplyCPAInhibitionToE2,
        testosteroneModelEnabled,
        setTestosteroneModelEnabled,
        baselineTestosteroneNgdL,
        setBaselineTestosteroneNgdL,
        simulation,
        calibrationModel,
        setCalibrationModel,
        calibrationMode,
        setCalibrationMode,
    } = useAppData();

    return (
        <LabView
            labResults={labResults}
            personalModel={personalModel}
            lastDiagnostics={lastDiagnostics}
            applyE2LearningToCPA={applyE2LearningToCPA}
            onSetApplyE2LearningToCPA={setApplyE2LearningToCPA}
            applyCPAInhibitionToE2={applyCPAInhibitionToE2}
            onSetApplyCPAInhibitionToE2={setApplyCPAInhibitionToE2}
            testosteroneModelEnabled={testosteroneModelEnabled}
            onSetTestosteroneModelEnabled={setTestosteroneModelEnabled}
            baselineTestosteroneNgdL={baselineTestosteroneNgdL}
            onSetBaselineTestosteroneNgdL={setBaselineTestosteroneNgdL}
            testosteroneSeries={simulation?.testosterone}
            calibrationModel={calibrationModel}
            onSetCalibrationModel={setCalibrationModel}
            calibrationMode={calibrationMode}
            onSetCalibrationMode={setCalibrationMode}
            onBack={() => navigate('/settings')}
        />
    );
};

export default LabPage;
