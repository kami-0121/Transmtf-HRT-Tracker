import React, { useMemo } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { Pill, Droplet } from 'lucide-react';
import { useAppData } from '../contexts/AppDataContext';
import { useTranslation } from '../contexts/LanguageContext';
import { DoseEvent } from '../../logic';
import HistoryView from '../views/HistoryView';
import BloodView from '../views/BloodView';
import TabBar from '../components/ui/TabBar';
import { buildBloodRows, type BloodRow } from '../utils/bloodTests';

interface OutletContext {
    onAddEvent: () => void;
    onEditEvent: (event: DoseEvent) => void;
    onBatchAdd: () => void;
    onAddBloodReport: () => void;
    onEditBloodRow: (row: BloodRow) => void;
}

type HistoryTab = 'meds' | 'blood';

const HistoryPage: React.FC = () => {
    const { onAddEvent, onEditEvent, onBatchAdd, onAddBloodReport, onEditBloodRow } = useOutletContext<OutletContext>();
    const { events, labResults, bloodReports } = useAppData();
    const { t } = useTranslation();
    const [params, setParams] = useSearchParams();
    const tab: HistoryTab = params.get('tab') === 'blood' ? 'blood' : 'meds';

    const rows = useMemo(() => buildBloodRows(bloodReports, labResults), [bloodReports, labResults]);

    return (
        <div className="relative space-y-5 pt-6 pb-16">
            <div className="px-4">
                <TabBar
                    tabs={[
                        { id: 'meds', label: t('history.tab.meds'), icon: <Pill size={15} /> },
                        { id: 'blood', label: t('history.tab.blood'), icon: <Droplet size={15} /> },
                    ]}
                    activeId={tab}
                    onChange={(id) => setParams(id === 'blood' ? { tab: 'blood' } : {}, { replace: true })}
                />
            </div>
            {tab === 'meds' ? (
                <HistoryView
                    events={events}
                    onAddEvent={onAddEvent}
                    onEditEvent={onEditEvent}
                    onBatchAdd={onBatchAdd}
                />
            ) : (
                <BloodView rows={rows} onAdd={onAddBloodReport} onEdit={onEditBloodRow} />
            )}
        </div>
    );
};

export default HistoryPage;
